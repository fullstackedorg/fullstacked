package crypto

import (
	"crypto"
	"crypto/hmac"
	"crypto/md5"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha3"
	"crypto/sha512"
	"encoding"
	"encoding/asn1"
	"fullstackedorg/fullstacked/types"
	"hash"
	"reflect"
	"sync"

	"golang.org/x/crypto/blake2b"
	"golang.org/x/crypto/blake2s"
	"golang.org/x/crypto/ripemd160"
)

type digest struct {
	name  string
	new   func() hash.Hash // nil for the SHAKE XOFs
	shake func() *sha3.SHAKE
	size  int         // output length, the default one for SHAKE
	id    crypto.Hash // 0 when Go has none, for RSA-PSS
	oid   asn1.ObjectIdentifier
}

func (d *digest) sum(data []byte) []byte {
	if d.shake != nil {
		h := d.shake()
		h.Write(data)
		out := make([]byte, d.size)
		h.Read(out)
		return out
	}
	h := d.new()
	h.Write(data)
	return h.Sum(nil)
}

// digests by their canonical lowercase name, the JS side maps the aliases
// (RSA-SHA256, sha256WithRSAEncryption, SHA256...)
var digests = map[string]*digest{}

func init() {
	nistHash := func(n int) asn1.ObjectIdentifier {
		return asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 2, n}
	}
	for _, d := range []*digest{
		{name: "md5", new: md5.New, size: md5.Size, id: crypto.MD5, oid: asn1.ObjectIdentifier{1, 2, 840, 113549, 2, 5}},
		{name: "sha1", new: sha1.New, size: sha1.Size, id: crypto.SHA1, oid: asn1.ObjectIdentifier{1, 3, 14, 3, 2, 26}},
		{name: "sha224", new: sha256.New224, size: sha256.Size224, id: crypto.SHA224, oid: nistHash(4)},
		{name: "sha256", new: sha256.New, size: sha256.Size, id: crypto.SHA256, oid: nistHash(1)},
		{name: "sha384", new: sha512.New384, size: sha512.Size384, id: crypto.SHA384, oid: nistHash(2)},
		{name: "sha512", new: sha512.New, size: sha512.Size, id: crypto.SHA512, oid: nistHash(3)},
		{name: "sha512-224", new: sha512.New512_224, size: sha512.Size224, id: crypto.SHA512_224, oid: nistHash(5)},
		{name: "sha512-256", new: sha512.New512_256, size: sha512.Size256, id: crypto.SHA512_256, oid: nistHash(6)},
		{name: "sha3-224", new: func() hash.Hash { return sha3.New224() }, size: 28, id: crypto.SHA3_224, oid: nistHash(7)},
		{name: "sha3-256", new: func() hash.Hash { return sha3.New256() }, size: 32, id: crypto.SHA3_256, oid: nistHash(8)},
		{name: "sha3-384", new: func() hash.Hash { return sha3.New384() }, size: 48, id: crypto.SHA3_384, oid: nistHash(9)},
		{name: "sha3-512", new: func() hash.Hash { return sha3.New512() }, size: 64, id: crypto.SHA3_512, oid: nistHash(10)},
		{name: "shake128", shake: sha3.NewSHAKE128, size: 16, oid: nistHash(11)},
		{name: "shake256", shake: sha3.NewSHAKE256, size: 32, oid: nistHash(12)},
		{name: "ripemd160", new: ripemd160.New, size: ripemd160.Size, id: crypto.RIPEMD160, oid: asn1.ObjectIdentifier{1, 3, 36, 3, 2, 1}},
		{name: "blake2b512", new: func() hash.Hash { h, _ := blake2b.New512(nil); return h }, size: 64, id: crypto.BLAKE2b_512, oid: asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 1722, 12, 2, 1, 16}},
		{name: "blake2s256", new: func() hash.Hash { h, _ := blake2s.New256(nil); return h }, size: 32, id: crypto.BLAKE2s_256, oid: asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 1722, 12, 2, 2, 8}},
	} {
		digests[d.name] = d
	}
}

func digestByOid(oid asn1.ObjectIdentifier) *digest {
	for _, d := range digests {
		if d.oid.Equal(oid) {
			return d
		}
	}
	return nil
}

type hashState struct {
	mu     sync.Mutex
	d      *digest
	h      hash.Hash // the HMAC as well
	xof    *sha3.SHAKE
	outLen int
	hmac   bool
}

// newHashState starts a hash, an HMAC when key is not nil. outLen < 0 means
// the default length.
func newHashState(algorithm string, key []byte, outLen int) (*hashState, error) {
	d := digests[algorithm]
	if d == nil {
		if key != nil {
			return nil, errInvalidDigest(algorithm)
		}
		return nil, errDigestNotSupported
	}

	s := &hashState{d: d, outLen: d.size, hmac: key != nil}

	if d.shake != nil {
		if key != nil {
			return nil, errHmacXOF
		}
		s.xof = d.shake()
		if outLen >= 0 {
			s.outLen = outLen
		}
		return s, nil
	}

	if outLen >= 0 && outLen != d.size {
		return nil, errNotXOF
	}
	if key != nil {
		s.h = hmac.New(d.new, key)
	} else {
		s.h = d.new()
	}
	return s, nil
}

func (s *hashState) write(data []byte) {
	if s.xof != nil {
		s.xof.Write(data)
	} else {
		s.h.Write(data)
	}
}

func (s *hashState) sum() []byte {
	if s.xof != nil {
		out := make([]byte, s.outLen)
		s.xof.Read(out)
		return out
	}
	return s.h.Sum(nil)
}

func (s *hashState) copy(outLen int) (*hashState, error) {
	c := &hashState{d: s.d, outLen: s.outLen, hmac: s.hmac}
	if outLen >= 0 {
		if s.xof == nil && outLen != s.d.size {
			return nil, errNotXOF
		}
		c.outLen = outLen
	}

	if s.xof != nil {
		state, err := s.xof.MarshalBinary()
		if err != nil {
			return nil, err
		}
		c.xof = s.d.shake()
		return c, c.xof.UnmarshalBinary(state)
	}

	h, err := cloneHash(s.h, s.d.new)
	if err != nil {
		return nil, newError("ERR_CRYPTO_HASH_FINALIZED", "Digest already called")
	}
	c.h = h
	return c, nil
}

func cloneHash(h hash.Hash, fresh func() hash.Hash) (hash.Hash, error) {
	if c, ok := h.(hash.Cloner); ok {
		cloned, err := c.Clone()
		if err != nil {
			return nil, err
		}
		return cloned.(hash.Hash), nil
	}

	if m, ok := h.(encoding.BinaryMarshaler); ok {
		state, err := m.MarshalBinary()
		if err != nil {
			return nil, err
		}
		c := fresh()
		return c, c.(encoding.BinaryUnmarshaler).UnmarshalBinary(state)
	}

	// x/crypto's ripemd160 has neither, its state is plain values
	v := reflect.ValueOf(h)
	if v.Kind() != reflect.Pointer || v.Elem().Kind() != reflect.Struct {
		return nil, errDigestNotSupported
	}
	c := reflect.New(v.Elem().Type())
	c.Elem().Set(v.Elem())
	return c.Interface().(hash.Hash), nil
}

func outputLength(a args, i int) int {
	if !a.defined(i) {
		return -1
	}
	return a.int(i, -1)
}

func hmacKey(a args, i int) []byte {
	if !a.defined(i) {
		return nil
	}
	key := a.buf(i)
	if key == nil {
		key = []byte{}
	}
	return key
}

// hashOneShot: algorithm, key?, data, outputLength?
func hashOneShot(_ *types.Context, a args) (any, error) {
	s, err := newHashState(a.str(0), hmacKey(a, 1), outputLength(a, 3))
	if err != nil {
		return nil, err
	}
	s.write(a.buf(2))
	return s.sum(), nil
}

// hashCreate: algorithm, key?, outputLength? -> handle
func hashCreate(ctx *types.Context, a args) (any, error) {
	s, err := newHashState(a.str(0), hmacKey(a, 1), outputLength(a, 2))
	if err != nil {
		return nil, err
	}
	id, err := newHandle(ctx, s)
	return float64(id), err
}

func hashUpdate(ctx *types.Context, a args) (any, error) {
	s, err := getHandle[*hashState](ctx, a, 0, false)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.write(a.buf(1))
	return nil, nil
}

func hashDigest(ctx *types.Context, a args) (any, error) {
	s, err := getHandle[*hashState](ctx, a, 0, true)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.sum(), nil
}

// hashCopy: handle, outputLength? -> new handle
func hashCopy(ctx *types.Context, a args) (any, error) {
	s, err := getHandle[*hashState](ctx, a, 0, false)
	if err != nil {
		return nil, err
	}
	s.mu.Lock()
	c, err := s.copy(outputLength(a, 1))
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	id, err := newHandle(ctx, c)
	return float64(id), err
}
