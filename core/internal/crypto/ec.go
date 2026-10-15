package crypto

import (
	"crypto/ecdh"
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"encoding/asn1"
	"math/big"

	"golang.org/x/crypto/cryptobyte"
	cbasn1 "golang.org/x/crypto/cryptobyte/asn1"
)

type ecCurve struct {
	name string // OpenSSL's, Node's namedCurve
	jwk  string // "" when JWK has no name for it
	oid  asn1.ObjectIdentifier
	size int            // bytes of a coordinate and of a scalar
	std  elliptic.Curve // nil for secp256k1
	dh   ecdh.Curve     // nil for P-224 and secp256k1
}

var curves = []*ecCurve{
	{name: "prime256v1", jwk: "P-256", oid: asn1.ObjectIdentifier{1, 2, 840, 10045, 3, 1, 7}, size: 32, std: elliptic.P256(), dh: ecdh.P256()},
	{name: "secp384r1", jwk: "P-384", oid: asn1.ObjectIdentifier{1, 3, 132, 0, 34}, size: 48, std: elliptic.P384(), dh: ecdh.P384()},
	{name: "secp521r1", jwk: "P-521", oid: asn1.ObjectIdentifier{1, 3, 132, 0, 35}, size: 66, std: elliptic.P521(), dh: ecdh.P521()},
	{name: "secp224r1", oid: asn1.ObjectIdentifier{1, 3, 132, 0, 33}, size: 28, std: elliptic.P224()},
	{name: "secp256k1", jwk: "secp256k1", oid: asn1.ObjectIdentifier{1, 3, 132, 0, 10}, size: 32},
}

func curveByName(name string) *ecCurve {
	for _, c := range curves {
		if c.name == name {
			return c
		}
	}
	return nil
}

func curveByOid(oid asn1.ObjectIdentifier) *ecCurve {
	for _, c := range curves {
		if c.oid.Equal(oid) {
			return c
		}
	}
	return nil
}

func curveByJwk(name string) *ecCurve {
	for _, c := range curves {
		if c.jwk != "" && c.jwk == name {
			return c
		}
	}
	return nil
}

// params returns p, a, b of y² = x³ + ax + b, a is -3 on the NIST curves
func (c *ecCurve) params() (p, a, b *big.Int) {
	if c.std == nil {
		return secp256k1.p, big.NewInt(0), secp256k1.b
	}
	params := c.std.Params()
	return params.P, big.NewInt(-3), params.B
}

func (c *ecCurve) order() *big.Int {
	if c.std == nil {
		return secp256k1.n
	}
	return c.std.Params().N
}

// scalar normalizes a private key of any length (Node takes leading zeros
// or none) to the curve size and checks 0 < k < n
func (c *ecCurve) scalar(k []byte) ([]byte, bool) {
	for len(k) > c.size && k[0] == 0 {
		k = k[1:]
	}
	if len(k) > c.size {
		return nil, false
	}
	padded := make([]byte, c.size)
	copy(padded[c.size-len(k):], k)

	if c.std == nil {
		return padded, secp256k1.validScalar(padded)
	}
	_, err := ecdsa.ParseRawPrivateKey(c.std, padded)
	return padded, err == nil
}

// publicKey computes the uncompressed point of a valid scalar
func (c *ecCurve) publicKey(scalar []byte) ([]byte, error) {
	if c.std == nil {
		x, y := secp256k1.scalarMult(secp256k1.gx, secp256k1.gy, scalar)
		return c.marshal(x, y), nil
	}
	priv, err := ecdsa.ParseRawPrivateKey(c.std, scalar)
	if err != nil {
		return nil, err
	}
	return priv.PublicKey.Bytes()
}

func (c *ecCurve) generate() (scalar, point []byte, err error) {
	if c.std == nil {
		scalar, err = secp256k1.randomScalar()
		if err != nil {
			return nil, nil, err
		}
		point, err = c.publicKey(scalar)
		return scalar, point, err
	}
	priv, err := ecdsa.GenerateKey(c.std, rand.Reader)
	if err != nil {
		return nil, nil, err
	}
	if scalar, err = priv.Bytes(); err != nil {
		return nil, nil, err
	}
	point, err = priv.PublicKey.Bytes()
	return scalar, point, err
}

func (c *ecCurve) marshal(x, y *big.Int) []byte {
	out := make([]byte, 1+2*c.size)
	out[0] = 4
	x.FillBytes(out[1 : 1+c.size])
	y.FillBytes(out[1+c.size:])
	return out
}

func (c *ecCurve) coordinates(point []byte) (*big.Int, *big.Int) {
	return new(big.Int).SetBytes(point[1 : 1+c.size]), new(big.Int).SetBytes(point[1+c.size:])
}

// validPoint checks an uncompressed point is on the curve
func (c *ecCurve) validPoint(point []byte) bool {
	if len(point) != 1+2*c.size || point[0] != 4 {
		return false
	}
	if c.std == nil {
		x, y := c.coordinates(point)
		return secp256k1.onCurve(x, y)
	}
	_, err := ecdsa.ParseUncompressedPublicKey(c.std, point)
	return err == nil
}

// decodePoint takes any SEC1 encoding (compressed 02/03, uncompressed 04,
// hybrid 06/07) and returns the validated uncompressed point. Public data
// only, so math/big is fine here.
func (c *ecCurve) decodePoint(b []byte) ([]byte, bool) {
	if len(b) == 0 {
		return nil, false
	}

	switch b[0] {
	case 4:
		return b, c.validPoint(b)
	case 6, 7:
		if len(b) != 1+2*c.size || b[len(b)-1]&1 != b[0]&1 {
			return nil, false
		}
		point := append([]byte{4}, b[1:]...)
		return point, c.validPoint(point)
	case 2, 3:
		if len(b) != 1+c.size {
			return nil, false
		}
		p, a, bb := c.params()
		x := new(big.Int).SetBytes(b[1:])
		if x.Cmp(p) >= 0 {
			return nil, false
		}
		// y² = x³ + ax + b
		y2 := new(big.Int).Mul(x, x)
		y2.Mul(y2, x)
		y2.Add(y2, new(big.Int).Mul(a, x))
		y2.Add(y2, bb)
		y2.Mod(y2, p)
		y := new(big.Int).ModSqrt(y2, p)
		if y == nil {
			return nil, false
		}
		if y.Bit(0) != uint(b[0]&1) {
			y.Sub(p, y)
		}
		point := c.marshal(x, y)
		return point, c.validPoint(point)
	}
	return nil, false
}

func (c *ecCurve) encodePoint(point []byte, format string) []byte {
	switch format {
	case "compressed":
		out := make([]byte, 1+c.size)
		out[0] = 2 | point[len(point)-1]&1
		copy(out[1:], point[1:1+c.size])
		return out
	case "hybrid":
		out := append([]byte(nil), point...)
		out[0] = 6 | point[len(point)-1]&1
		return out
	}
	return append([]byte(nil), point...)
}

// sharedSecret is the x coordinate of scalar × point, both valid
func (c *ecCurve) sharedSecret(scalar, point []byte) ([]byte, error) {
	if c.dh != nil {
		priv, err := c.dh.NewPrivateKey(scalar)
		if err != nil {
			return nil, err
		}
		pub, err := c.dh.NewPublicKey(point)
		if err != nil {
			return nil, err
		}
		return priv.ECDH(pub)
	}

	x, y := c.coordinates(point)
	var sx *big.Int
	if c.std == nil {
		sx, _ = secp256k1.scalarMult(x, y, scalar)
	} else {
		// P-224 is not in crypto/ecdh, its elliptic implementation is the
		// constant-time nistec one
		sx, _ = c.std.ScalarMult(x, y, scalar)
	}
	if sx == nil {
		return nil, errDerivationFailed
	}
	return sx.FillBytes(make([]byte, c.size)), nil
}

func (c *ecCurve) sign(scalar, digest []byte) ([]byte, error) {
	if c.std == nil {
		r, s, err := secp256k1.sign(scalar, digest)
		if err != nil {
			return nil, err
		}
		return marshalEcdsaSignature(r, s), nil
	}
	priv, err := ecdsa.ParseRawPrivateKey(c.std, scalar)
	if err != nil {
		return nil, err
	}
	return ecdsa.SignASN1(rand.Reader, priv, digest)
}

func (c *ecCurve) verify(point, digest, sig []byte) bool {
	if c.std == nil {
		r, s, ok := parseEcdsaSignature(sig)
		if !ok {
			return false
		}
		x, y := c.coordinates(point)
		return secp256k1.verify(x, y, digest, r, s)
	}
	pub, err := ecdsa.ParseUncompressedPublicKey(c.std, point)
	if err != nil {
		return false
	}
	return ecdsa.VerifyASN1(pub, digest, sig)
}

func marshalEcdsaSignature(r, s *big.Int) []byte {
	var b cryptobyte.Builder
	b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
		b.AddASN1BigInt(r)
		b.AddASN1BigInt(s)
	})
	return b.BytesOrPanic()
}

func parseEcdsaSignature(sig []byte) (*big.Int, *big.Int, bool) {
	r, s := new(big.Int), new(big.Int)
	input := cryptobyte.String(sig)
	var inner cryptobyte.String
	if !input.ReadASN1(&inner, cbasn1.SEQUENCE) || !input.Empty() ||
		!inner.ReadASN1Integer(r) || !inner.ReadASN1Integer(s) || !inner.Empty() {
		return nil, nil, false
	}
	return r, s, true
}

// ieee-p1363 is r || s, each the size of the order
func (c *ecCurve) toP1363(der []byte) ([]byte, error) {
	r, s, ok := parseEcdsaSignature(der)
	if !ok {
		return nil, newError("ERR_CRYPTO_OPERATION_FAILED", "Failed to convert signature")
	}
	n := (c.order().BitLen() + 7) / 8
	out := make([]byte, 2*n)
	r.FillBytes(out[:n])
	s.FillBytes(out[n:])
	return out, nil
}

func (c *ecCurve) fromP1363(sig []byte) ([]byte, bool) {
	n := (c.order().BitLen() + 7) / 8
	if len(sig) != 2*n {
		return nil, false
	}
	return marshalEcdsaSignature(new(big.Int).SetBytes(sig[:n]), new(big.Int).SetBytes(sig[n:])), true
}
