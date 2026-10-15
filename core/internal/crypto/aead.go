package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/subtle"
	"encoding/binary"
	"fullstackedorg/fullstacked/types"

	"golang.org/x/crypto/chacha20"
	"golang.org/x/crypto/chacha20poly1305"
)

// aeadState is a streaming GCM or ChaCha20-Poly1305. OpenSSL outputs each
// update right away, so the output is the AEAD's own keystream applied as
// the data comes, and the tag is the standard library's over all of it at
// final. The plaintext is kept until then.
type aeadState struct {
	mode    cipherMode
	decrypt bool
	tagLen  int // the authTagLength option, 0 when not given
	aead    cipher.AEAD
	nonce   []byte
	stream  cipher.Stream
	aad     []byte
	text    []byte // the plaintext so far
	tag     []byte // expected tag when decrypting
}

func tagLength(a args, i int) int {
	if !a.defined(i) {
		return 0
	}
	return a.int(i, 0)
}

func validTagLength(mode cipherMode, n int) bool {
	if mode == modeGCM {
		return n == 4 || n == 8 || (n >= 12 && n <= 16)
	}
	return n >= 1 && n <= 16
}

func newAeadState(spec *cipherSpec, key, iv []byte, decrypt bool, tagLen int) (*aeadState, error) {
	if tagLen != 0 && !validTagLength(spec.mode, tagLen) {
		return nil, errInvalidAuthTag(tagLen)
	}

	s := &aeadState{mode: spec.mode, decrypt: decrypt, tagLen: tagLen, nonce: clone(iv)}

	if spec.mode == modeChaCha20Poly1305 {
		aead, err := chacha20poly1305.New(key)
		if err != nil {
			return nil, errInvalidKeyLength
		}
		stream, err := chacha20.NewUnauthenticatedCipher(key, iv)
		if err != nil {
			return nil, errInvalidIV
		}
		// block 0 is the Poly1305 key, the data starts at block 1
		stream.SetCounter(1)
		s.aead, s.stream = aead, stream
		return s, nil
	}

	block, err := aes.NewCipher(key)
	if err != nil {
		return nil, errInvalidKeyLength
	}
	if len(iv) == 12 {
		s.aead, err = cipher.NewGCM(block)
	} else {
		s.aead, err = cipher.NewGCMWithNonceSize(block, len(iv))
	}
	if err != nil {
		return nil, errInvalidIV
	}
	s.stream = newGCMStream(block, iv, s.aead)
	return s, nil
}

// setTag validates the tag like Node's setAuthTag: the authTagLength
// option when given, otherwise any GCM length, 16 for ChaCha20-Poly1305
func (s *aeadState) setTag(tag []byte) error {
	n := len(tag)
	switch {
	case s.tagLen != 0:
		if n != s.tagLen {
			return errInvalidAuthTag(n)
		}
	case s.mode == modeGCM:
		if !validTagLength(modeGCM, n) {
			return errInvalidAuthTag(n)
		}
	default:
		if n != 16 {
			return errInvalidAuthTag(n)
		}
	}
	s.tag = clone(tag)
	return nil
}

func (s *aeadState) update(data []byte) []byte {
	out := make([]byte, len(data))
	s.stream.XORKeyStream(out, data)
	if s.decrypt {
		s.text = append(s.text, out...)
	} else {
		s.text = append(s.text, data...)
	}
	return out
}

func (s *aeadState) outTagLen() int {
	if s.tagLen != 0 {
		return s.tagLen
	}
	return 16
}

// fullTag recomputes the 16-byte tag over the plaintext with the
// standard library's constant-time AEAD
func (s *aeadState) fullTag(plaintext []byte) []byte {
	sealed := s.aead.Seal(nil, s.nonce, plaintext, s.aad)
	return sealed[len(plaintext):]
}

func (s *aeadState) final() ([]byte, error) {
	tag := s.fullTag(s.text)
	s.text = nil

	if !s.decrypt {
		return tag[:s.outTagLen()], nil
	}

	if s.tag == nil || subtle.ConstantTimeCompare(tag[:len(s.tag)], s.tag) != 1 {
		return nil, errAuthFailed
	}
	return []byte{}, nil
}

// gcmStream is GCM's CTR: the counter's last 32 bits wrap without carrying
// (inc32), which cipher.NewCTR does not do, so the stream is cut where they
// wrap. Within a segment both are the same.
type gcmStream struct {
	block   cipher.Block
	counter [16]byte
	ctr     cipher.Stream
	left    uint64 // bytes before the 32-bit counter wraps
}

func newGCMStream(block cipher.Block, iv []byte, aead cipher.AEAD) *gcmStream {
	g := &gcmStream{block: block}
	if len(iv) == 12 {
		copy(g.counter[:], iv)
		g.counter[15] = 2
	} else {
		// J0 is GHASH(IV) for other lengths: encrypting a zero block gives
		// E(inc32(J0)), decrypting that gives the first counter block
		// without a GHASH of our own
		ks := aead.Seal(nil, iv, make([]byte, 16), nil)
		block.Decrypt(g.counter[:], ks[:16])
	}
	g.segment()
	return g
}

func (g *gcmStream) segment() {
	low := binary.BigEndian.Uint32(g.counter[12:])
	g.left = (1<<32 - uint64(low)) * 16
	g.ctr = cipher.NewCTR(g.block, g.counter[:])
}

func (g *gcmStream) XORKeyStream(dst, src []byte) {
	for len(src) > 0 {
		n := len(src)
		if uint64(n) > g.left {
			n = int(g.left)
		}
		g.ctr.XORKeyStream(dst[:n], src[:n])
		dst, src = dst[n:], src[n:]
		g.left -= uint64(n)

		if g.left == 0 {
			binary.BigEndian.PutUint32(g.counter[12:], 0)
			g.segment()
		}
	}
}

// aeadOneShot: algorithm, key, iv, decrypt, authTagLength?, aad?, authTag?,
// data -> 1 status byte then the payload. Encrypting: 0, ciphertext then
// tag. Decrypting: 0 without a tag, 1 tag verified, 2 tag mismatch, then
// the plaintext in every case (Node's update returns it before final throws).
func aeadOneShot(_ *types.Context, a args) (any, error) {
	key, iv := a.buf(1), a.buf(2)
	spec, err := checkCipher(a.str(0), key, iv, true)
	if err != nil {
		return nil, err
	}
	if !spec.aead() {
		return nil, errUnknownCipher
	}

	decrypt := a.bool(3)
	s, err := newAeadState(spec, key, iv, decrypt, tagLength(a, 4))
	if err != nil {
		return nil, err
	}
	s.aad = a.buf(5)
	data := a.buf(7)

	if !decrypt {
		sealed := s.aead.Seal([]byte{0}, s.nonce, data, s.aad)
		return sealed[:1+len(data)+s.outTagLen()], nil
	}

	if !a.defined(6) {
		out := make([]byte, 1+len(data))
		s.stream.XORKeyStream(out[1:], data)
		return out, nil
	}
	if err := s.setTag(a.buf(6)); err != nil {
		return nil, err
	}

	if len(s.tag) == 16 {
		sealed := make([]byte, 0, len(data)+16)
		sealed = append(append(sealed, data...), s.tag...)
		if plaintext, err := s.aead.Open([]byte{1}, s.nonce, sealed, s.aad); err == nil {
			return plaintext, nil
		}
	}

	out := make([]byte, 1+len(data))
	s.stream.XORKeyStream(out[1:], data)
	out[0] = 2
	if subtle.ConstantTimeCompare(s.fullTag(out[1:])[:len(s.tag)], s.tag) == 1 {
		out[0] = 1
	}
	return out, nil
}
