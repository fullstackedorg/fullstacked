package crypto

import (
	"crypto/hkdf"
	"crypto/pbkdf2"
	"fullstackedorg/fullstacked/types"
	"hash"
	"math"

	"golang.org/x/crypto/scrypt"
)

// pbkdf2Fn: password, salt, iterations, keylen, digest -> key
func pbkdf2Fn(_ *types.Context, a args) (any, error) {
	name := a.str(4)
	d := digests[name]
	if d == nil {
		return nil, errInvalidDigest(name)
	}
	keyLen, iterations := a.int(3, 0), a.int(2, 0)
	// Node 24 fails a zero length and the XOFs the same way
	if d.new == nil || keyLen <= 0 || iterations < 1 {
		return nil, errDerivingBits
	}
	key, err := pbkdf2.Key(func() hash.Hash { return d.new() }, string(a.buf(0)), a.buf(1), iterations, keyLen)
	if err != nil {
		return nil, errDerivingBits
	}
	return key, nil
}

type scryptOptions struct {
	N      float64 `json:"N"`
	R      float64 `json:"r"`
	P      float64 `json:"p"`
	Maxmem float64 `json:"maxmem"`
}

// scryptFn: password, salt, keylen, options { N, r, p, maxmem } -> key
func scryptFn(_ *types.Context, a args) (any, error) {
	var o scryptOptions
	if err := a.object(3, &o); err != nil {
		return nil, errScryptParams
	}
	if !scryptParamsValid(o) {
		return nil, errScryptParams
	}
	keyLen := a.int(2, 0)
	if keyLen == 0 {
		return []byte{}, nil
	}
	key, err := scrypt.Key(a.buf(0), a.buf(1), int(o.N), int(o.R), int(o.P), keyLen)
	if err != nil {
		return nil, errScryptParams
	}
	return key, nil
}

// scryptParamsValid repeats OpenSSL's checks, memory included: 128·r·p for
// B plus 128·r·(N+2) for V must fit in maxmem
func scryptParamsValid(o scryptOptions) bool {
	n, r, p := o.N, o.R, o.P
	if r < 1 || p < 1 || n < 2 || n != math.Trunc(n) || r != math.Trunc(r) || p != math.Trunc(p) || n > 1<<53 {
		return false
	}
	N := uint64(n)
	if N&(N-1) != 0 || p > float64((1<<30-1))/r {
		return false
	}
	if 16*r <= 63 && N >= uint64(1)<<uint64(16*r) {
		return false
	}
	maxmem := o.Maxmem
	if maxmem == 0 {
		maxmem = 32 << 20
	}
	return 128*r*p+128*r*(n+2) <= maxmem
}

// hkdfFn: digest, ikm, salt, info, keylen -> key
func hkdfFn(_ *types.Context, a args) (any, error) {
	name := a.str(0)
	d := digests[name]
	if d == nil {
		return nil, errInvalidDigest(name)
	}
	keyLen := a.int(4, 0)
	if d.new != nil && keyLen > 255*d.size {
		return nil, errInvalidKeyLength
	}
	if d.new == nil || keyLen <= 0 {
		return nil, errDerivingBits
	}
	key, err := hkdf.Key(func() hash.Hash { return d.new() }, a.buf(1), a.buf(2), string(a.buf(3)), keyLen)
	if err != nil {
		return nil, errDerivingBits
	}
	return key, nil
}
