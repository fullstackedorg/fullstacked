package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/des"
	"crypto/subtle"
	"encoding/binary"
	"fullstackedorg/fullstacked/types"
	"strconv"
	"sync"

	"golang.org/x/crypto/chacha20"
)

type cipherMode int

const (
	modeCBC cipherMode = iota
	modeECB
	modeCTR
	modeCFB
	modeCFB8
	modeOFB
	modeGCM
	modeChaCha20
	modeChaCha20Poly1305
)

type cipherSpec struct {
	keyLen int
	ivLen  int // 0 for ECB; GCM takes 1 to 128 bytes
	mode   cipherMode
	block  func(key []byte) (cipher.Block, error)
}

func (s *cipherSpec) aead() bool {
	return s.mode == modeGCM || s.mode == modeChaCha20Poly1305
}

func newDesEde(key []byte) (cipher.Block, error) {
	k := make([]byte, 0, 24)
	k = append(append(k, key...), key[:8]...)
	return des.NewTripleDESCipher(k)
}

// ciphers by their canonical lowercase name, the JS side maps the aliases
// (aes128 -> aes-128-cbc, id-aes128-GCM -> aes-128-gcm, des3 -> des-ede3-cbc...)
var ciphers = map[string]*cipherSpec{}

func init() {
	aesModes := map[string]cipherMode{
		"cbc": modeCBC, "ecb": modeECB, "ctr": modeCTR, "cfb": modeCFB,
		"cfb8": modeCFB8, "ofb": modeOFB, "gcm": modeGCM,
	}
	for _, keyLen := range []int{16, 24, 32} {
		for name, mode := range aesModes {
			ivLen := aes.BlockSize
			switch mode {
			case modeECB:
				ivLen = 0
			case modeGCM:
				ivLen = 12
			}
			ciphers["aes-"+strconv.Itoa(keyLen*8)+"-"+name] = &cipherSpec{keyLen: keyLen, ivLen: ivLen, mode: mode, block: aes.NewCipher}
		}
	}

	ciphers["chacha20"] = &cipherSpec{keyLen: chacha20.KeySize, ivLen: 16, mode: modeChaCha20}
	ciphers["chacha20-poly1305"] = &cipherSpec{keyLen: chacha20.KeySize, ivLen: 12, mode: modeChaCha20Poly1305}

	// des-cbc and des-ecb are in OpenSSL's legacy provider, which Node 24
	// does not load: it fails them with ERR_OSSL_EVP_UNSUPPORTED
	des3 := des.NewTripleDESCipher
	for name, spec := range map[string]*cipherSpec{
		"des-ede3-cbc": {keyLen: 24, ivLen: 8, mode: modeCBC, block: des3},
		"des-ede3":     {keyLen: 24, mode: modeECB, block: des3},
		"des-ede-cbc":  {keyLen: 16, ivLen: 8, mode: modeCBC, block: newDesEde},
		"des-ede":      {keyLen: 16, mode: modeECB, block: newDesEde},
		"des-cbc":      {keyLen: 8, ivLen: 8, mode: modeCBC, block: des.NewCipher},
		"des-ecb":      {keyLen: 8, mode: modeECB, block: des.NewCipher},
	} {
		ciphers[name] = spec
	}
}

// checkCipher validates key and iv the way Node does before anything runs
func checkCipher(algorithm string, key, iv []byte, ivGiven bool) (*cipherSpec, error) {
	spec := ciphers[algorithm]
	if spec == nil {
		return nil, errUnknownCipher
	}
	if len(key) != spec.keyLen {
		return nil, errInvalidKeyLength
	}

	switch spec.mode {
	case modeECB:
		// Node takes null or an empty buffer
		if ivGiven && len(iv) != 0 {
			return nil, errInvalidIV
		}
	case modeGCM:
		if len(iv) < 1 || len(iv) > 128 {
			return nil, errInvalidIV
		}
	default:
		if len(iv) != spec.ivLen {
			return nil, errInvalidIV
		}
	}
	return spec, nil
}

type cipherState struct {
	mu      sync.Mutex
	spec    *cipherSpec
	decrypt bool
	padding bool

	// CBC and ECB: the input not processed yet, a partial block, or the
	// last full block held back on decryption until final removes padding
	blocks  cipher.BlockMode
	pending []byte

	stream cipher.Stream
	aead   *aeadState
}

func newCipherState(spec *cipherSpec, key, iv []byte, decrypt bool) (*cipherState, error) {
	s := &cipherState{spec: spec, decrypt: decrypt, padding: true}

	switch spec.mode {
	case modeChaCha20:
		stream, err := newOpenSSLChaCha20(key, iv)
		if err != nil {
			return nil, err
		}
		s.stream = stream
		return s, nil
	case modeGCM, modeChaCha20Poly1305:
		// the AEAD state is set by the caller, it needs the tag length
		return s, nil
	}

	block, err := spec.block(key)
	if err != nil {
		return nil, errInvalidKeyLength
	}

	switch spec.mode {
	case modeCBC:
		if decrypt {
			s.blocks = cipher.NewCBCDecrypter(block, iv)
		} else {
			s.blocks = cipher.NewCBCEncrypter(block, iv)
		}
	case modeECB:
		s.blocks = &ecb{block, decrypt}
	case modeCTR:
		s.stream = cipher.NewCTR(block, iv)
	case modeOFB:
		s.stream = cipher.NewOFB(block, iv)
	case modeCFB:
		if decrypt {
			s.stream = cipher.NewCFBDecrypter(block, iv)
		} else {
			s.stream = cipher.NewCFBEncrypter(block, iv)
		}
	case modeCFB8:
		s.stream = newCFB8(block, iv, decrypt)
	}
	return s, nil
}

func (s *cipherState) update(data []byte) ([]byte, error) {
	if s.aead != nil {
		return s.aead.update(data), nil
	}

	if s.stream != nil {
		out := make([]byte, len(data))
		s.stream.XORKeyStream(out, data)
		return out, nil
	}

	// OpenSSL outputs every complete block except, when decrypting with
	// padding, the last one if nothing follows it: it may be the padding
	bs := s.blocks.BlockSize()
	total := len(s.pending) + len(data)
	keep := total % bs
	if s.decrypt && s.padding && keep == 0 && total > 0 {
		keep = bs
	}
	n := total - keep

	out := make([]byte, n)
	if n > 0 {
		in := data
		if len(s.pending) > 0 {
			in = append(s.pending, data...)
		}
		s.blocks.CryptBlocks(out, in[:n])
		s.pending = append([]byte(nil), in[n:]...)
	} else {
		s.pending = append(s.pending, data...)
	}
	return out, nil
}

func (s *cipherState) final() ([]byte, error) {
	if s.stream != nil {
		return []byte{}, nil
	}

	bs := s.blocks.BlockSize()
	if !s.padding {
		if len(s.pending) != 0 {
			return nil, errWrongFinalBlock
		}
		return []byte{}, nil
	}

	if !s.decrypt {
		n := bs - len(s.pending)
		block := append(s.pending, make([]byte, n)...)
		for i := len(s.pending); i < bs; i++ {
			block[i] = byte(n)
		}
		out := make([]byte, bs)
		s.blocks.CryptBlocks(out, block)
		return out, nil
	}

	if len(s.pending) != bs {
		return nil, errWrongFinalBlock
	}
	out := make([]byte, bs)
	s.blocks.CryptBlocks(out, s.pending)

	n, ok := unpad(out)
	if !ok {
		return nil, errBadDecrypt
	}
	return out[:bs-n], nil
}

// unpad checks PKCS#7 padding without branching on the plaintext bytes
func unpad(block []byte) (int, bool) {
	bs := len(block)
	n := int(block[bs-1])
	good := subtle.ConstantTimeLessOrEq(1, n) & subtle.ConstantTimeLessOrEq(n, bs)
	for i := 0; i < bs; i++ {
		inPad := subtle.ConstantTimeLessOrEq(bs-n, i)
		good &= subtle.ConstantTimeSelect(inPad, subtle.ConstantTimeByteEq(block[i], byte(n)), 1)
	}
	return n, good == 1
}

// ecb is the block mode Go leaves out on purpose, Node has it
type ecb struct {
	block   cipher.Block
	decrypt bool
}

func (e *ecb) BlockSize() int { return e.block.BlockSize() }

func (e *ecb) CryptBlocks(dst, src []byte) {
	bs := e.block.BlockSize()
	for i := 0; i < len(src); i += bs {
		if e.decrypt {
			e.block.Decrypt(dst[i:i+bs], src[i:i+bs])
		} else {
			e.block.Encrypt(dst[i:i+bs], src[i:i+bs])
		}
	}
}

// cfb8 is CFB with 8-bit feedback, one block encryption per byte
type cfb8 struct {
	block    cipher.Block
	register []byte
	out      []byte
	decrypt  bool
}

func newCFB8(block cipher.Block, iv []byte, decrypt bool) *cfb8 {
	return &cfb8{block, append([]byte(nil), iv...), make([]byte, block.BlockSize()), decrypt}
}

func (c *cfb8) XORKeyStream(dst, src []byte) {
	for i, in := range src {
		c.block.Encrypt(c.out, c.register)
		out := in ^ c.out[0]
		feedback := out
		if c.decrypt {
			feedback = in
		}
		copy(c.register, c.register[1:])
		c.register[len(c.register)-1] = feedback
		dst[i] = out
	}
}

// openSSLChaCha20 is OpenSSL's "chacha20": the 16-byte IV is a 32-bit
// little-endian block counter then a 96-bit nonce, and the counter carries
// into the first nonce word when it wraps
type openSSLChaCha20 struct {
	key     []byte
	nonce   []byte
	c       *chacha20.Cipher
	toCarry uint64 // bytes left before the counter wraps
}

func newOpenSSLChaCha20(key, iv []byte) (*openSSLChaCha20, error) {
	s := &openSSLChaCha20{key: append([]byte(nil), key...), nonce: append([]byte(nil), iv[4:]...)}
	return s, s.reset(binary.LittleEndian.Uint32(iv))
}

func (s *openSSLChaCha20) reset(counter uint32) error {
	c, err := chacha20.NewUnauthenticatedCipher(s.key, s.nonce)
	if err != nil {
		return err
	}
	c.SetCounter(counter)
	s.c = c
	s.toCarry = (1<<32 - uint64(counter)) * 64
	return nil
}

func (s *openSSLChaCha20) XORKeyStream(dst, src []byte) {
	for len(src) > 0 {
		n := len(src)
		if uint64(n) > s.toCarry {
			n = int(s.toCarry)
		}
		s.c.XORKeyStream(dst[:n], src[:n])
		dst, src = dst[n:], src[n:]
		s.toCarry -= uint64(n)

		if s.toCarry == 0 {
			binary.LittleEndian.PutUint32(s.nonce, binary.LittleEndian.Uint32(s.nonce)+1)
			s.reset(0)
		}
	}
}

// cipherInit: algorithm, key, iv?, decrypt, authTagLength?, autoPadding,
// aad?, authTag?, data? -> 4 bytes handle then the output of data
func cipherInit(ctx *types.Context, a args) (any, error) {
	key, iv := a.buf(1), a.buf(2)
	spec, err := checkCipher(a.str(0), key, iv, a.defined(2))
	if err != nil {
		return nil, err
	}

	decrypt := a.bool(3)
	s, err := newCipherState(spec, key, iv, decrypt)
	if err != nil {
		return nil, err
	}
	if a.defined(5) {
		s.padding = a.bool(5)
	}

	if spec.aead() {
		s.aead, err = newAeadState(spec, key, iv, decrypt, tagLength(a, 4))
		if err != nil {
			return nil, err
		}
		s.aead.aad = clone(a.buf(6))
		if decrypt && a.defined(7) {
			if err = s.aead.setTag(a.buf(7)); err != nil {
				return nil, err
			}
		}
	}

	out := []byte{}
	if a.defined(8) {
		out, err = s.update(a.buf(8))
		if err != nil {
			return nil, err
		}
	}

	id, err := newHandle(ctx, s)
	if err != nil {
		return nil, err
	}
	return append(handleBytes(id), out...), nil
}

func cipherUpdate(ctx *types.Context, a args) (any, error) {
	s, err := getHandle[*cipherState](ctx, a, 0, false)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.update(a.buf(1))
}

// cipherFinal: handle, authTag? -> final output, then the tag when
// encrypting with an AEAD. The handle is gone after it, error or not.
func cipherFinal(ctx *types.Context, a args) (any, error) {
	s, err := getHandle[*cipherState](ctx, a, 0, true)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.aead != nil {
		if s.decrypt && a.defined(1) {
			if err := s.aead.setTag(a.buf(1)); err != nil {
				return nil, err
			}
		}
		return s.aead.final()
	}
	return s.final()
}

func cipherSetAutoPadding(ctx *types.Context, a args) (any, error) {
	s, err := getHandle[*cipherState](ctx, a, 0, false)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	s.padding = a.bool(1)
	s.mu.Unlock()
	return nil, nil
}
