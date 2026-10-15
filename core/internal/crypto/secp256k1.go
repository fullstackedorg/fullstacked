package crypto

import (
	"crypto/rand"
	"math/big"
)

// secp256k1 has no Go standard library support. This is plain math/big
// arithmetic: correct but NOT constant time, the scalar multiplication
// branches on the bits of the private key. Node (OpenSSL) supports the
// curve, so it is kept for compatibility (ECDH, ECDSA, keys); prefer the
// NIST curves or X25519 for anything new.
type k1Curve struct {
	p, n, b, gx, gy *big.Int
}

var secp256k1 = func() *k1Curve {
	hex := func(s string) *big.Int {
		v, _ := new(big.Int).SetString(s, 16)
		return v
	}
	return &k1Curve{
		p:  hex("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEFFFFFC2F"),
		n:  hex("FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141"),
		b:  big.NewInt(7),
		gx: hex("79BE667EF9DCBBAC55A06295CE870B07029BFCDB2DCE28D959F2815B16F81798"),
		gy: hex("483ADA7726A3C4655DA4FBFC0E1108A8FD17B448A68554199C47D08FFB10D4B8"),
	}
}()

// jacobian point (X/Z², Y/Z³), Z = 0 is the point at infinity
type k1Point struct {
	x, y, z *big.Int
}

func (c *k1Curve) mod(v *big.Int) *big.Int {
	return v.Mod(v, c.p)
}

func (c *k1Curve) onCurve(x, y *big.Int) bool {
	if x.Sign() < 0 || x.Cmp(c.p) >= 0 || y.Sign() < 0 || y.Cmp(c.p) >= 0 {
		return false
	}
	y2 := c.mod(new(big.Int).Mul(y, y))
	x3 := new(big.Int).Mul(x, x)
	x3.Mul(x3, x)
	x3.Add(x3, c.b)
	return y2.Cmp(c.mod(x3)) == 0
}

func (c *k1Curve) double(p k1Point) k1Point {
	if p.z.Sign() == 0 || p.y.Sign() == 0 {
		return k1Point{big.NewInt(0), big.NewInt(1), big.NewInt(0)}
	}
	a := c.mod(new(big.Int).Mul(p.x, p.x))
	b := c.mod(new(big.Int).Mul(p.y, p.y))
	cc := c.mod(new(big.Int).Mul(b, b))
	d := new(big.Int).Add(p.x, b)
	d.Mul(d, d)
	d.Sub(d, a)
	d.Sub(d, cc)
	d.Lsh(d, 1)
	c.mod(d)
	e := new(big.Int).Mul(a, big.NewInt(3))
	f := c.mod(new(big.Int).Mul(e, e))

	x3 := new(big.Int).Sub(f, new(big.Int).Lsh(d, 1))
	c.mod(x3)
	y3 := new(big.Int).Sub(d, x3)
	y3.Mul(y3, e)
	y3.Sub(y3, new(big.Int).Lsh(cc, 3))
	c.mod(y3)
	z3 := new(big.Int).Mul(p.y, p.z)
	z3.Lsh(z3, 1)
	c.mod(z3)
	return k1Point{x3, y3, z3}
}

func (c *k1Curve) add(p, q k1Point) k1Point {
	if p.z.Sign() == 0 {
		return q
	}
	if q.z.Sign() == 0 {
		return p
	}
	z1z1 := c.mod(new(big.Int).Mul(p.z, p.z))
	z2z2 := c.mod(new(big.Int).Mul(q.z, q.z))
	u1 := c.mod(new(big.Int).Mul(p.x, z2z2))
	u2 := c.mod(new(big.Int).Mul(q.x, z1z1))
	s1 := new(big.Int).Mul(p.y, q.z)
	s1.Mul(s1, z2z2)
	c.mod(s1)
	s2 := new(big.Int).Mul(q.y, p.z)
	s2.Mul(s2, z1z1)
	c.mod(s2)

	if u1.Cmp(u2) == 0 {
		if s1.Cmp(s2) == 0 {
			return c.double(p)
		}
		return k1Point{big.NewInt(0), big.NewInt(1), big.NewInt(0)}
	}

	h := c.mod(new(big.Int).Sub(u2, u1))
	i := new(big.Int).Lsh(h, 1)
	i.Mul(i, i)
	c.mod(i)
	j := c.mod(new(big.Int).Mul(h, i))
	r := new(big.Int).Sub(s2, s1)
	r.Lsh(r, 1)
	c.mod(r)
	v := c.mod(new(big.Int).Mul(u1, i))

	x3 := new(big.Int).Mul(r, r)
	x3.Sub(x3, j)
	x3.Sub(x3, new(big.Int).Lsh(v, 1))
	c.mod(x3)
	y3 := new(big.Int).Sub(v, x3)
	y3.Mul(y3, r)
	y3.Sub(y3, new(big.Int).Lsh(new(big.Int).Mul(s1, j), 1))
	c.mod(y3)
	z3 := new(big.Int).Add(p.z, q.z)
	z3.Mul(z3, z3)
	z3.Sub(z3, z1z1)
	z3.Sub(z3, z2z2)
	z3.Mul(z3, h)
	c.mod(z3)
	return k1Point{x3, y3, z3}
}

func (c *k1Curve) scalarMult(x, y *big.Int, k []byte) (*big.Int, *big.Int) {
	acc := k1Point{big.NewInt(0), big.NewInt(1), big.NewInt(0)}
	base := k1Point{new(big.Int).Set(x), new(big.Int).Set(y), big.NewInt(1)}
	for _, b := range k {
		for bit := 7; bit >= 0; bit-- {
			acc = c.double(acc)
			if b>>uint(bit)&1 == 1 {
				acc = c.add(acc, base)
			}
		}
	}
	return c.affine(acc)
}

func (c *k1Curve) affine(p k1Point) (*big.Int, *big.Int) {
	if p.z.Sign() == 0 {
		return nil, nil
	}
	zinv := new(big.Int).ModInverse(p.z, c.p)
	zinv2 := c.mod(new(big.Int).Mul(zinv, zinv))
	x := c.mod(new(big.Int).Mul(p.x, zinv2))
	y := new(big.Int).Mul(p.y, zinv2)
	y.Mul(y, zinv)
	return x, c.mod(y)
}

func (c *k1Curve) validScalar(k []byte) bool {
	v := new(big.Int).SetBytes(k)
	return v.Sign() > 0 && v.Cmp(c.n) < 0
}

func (c *k1Curve) randomScalar() ([]byte, error) {
	max := new(big.Int).Sub(c.n, big.NewInt(1))
	v, err := rand.Int(rand.Reader, max)
	if err != nil {
		return nil, err
	}
	v.Add(v, big.NewInt(1))
	return v.FillBytes(make([]byte, 32)), nil
}

// hashToInt takes the leftmost bits of the digest, as ECDSA does
func (c *k1Curve) hashToInt(digest []byte) *big.Int {
	if len(digest) > 32 {
		digest = digest[:32]
	}
	return new(big.Int).SetBytes(digest)
}

func (c *k1Curve) sign(scalar, digest []byte) (*big.Int, *big.Int, error) {
	d := new(big.Int).SetBytes(scalar)
	e := c.hashToInt(digest)
	for {
		kb, err := c.randomScalar()
		if err != nil {
			return nil, nil, err
		}
		x, _ := c.scalarMult(c.gx, c.gy, kb)
		r := new(big.Int).Mod(x, c.n)
		if r.Sign() == 0 {
			continue
		}
		k := new(big.Int).SetBytes(kb)
		s := new(big.Int).Mul(r, d)
		s.Add(s, e)
		s.Mul(s, new(big.Int).ModInverse(k, c.n))
		s.Mod(s, c.n)
		if s.Sign() != 0 {
			return r, s, nil
		}
	}
}

func (c *k1Curve) verify(x, y *big.Int, digest []byte, r, s *big.Int) bool {
	if r.Sign() <= 0 || s.Sign() <= 0 || r.Cmp(c.n) >= 0 || s.Cmp(c.n) >= 0 {
		return false
	}
	e := c.hashToInt(digest)
	w := new(big.Int).ModInverse(s, c.n)
	u1 := new(big.Int).Mul(e, w)
	u1.Mod(u1, c.n)
	u2 := new(big.Int).Mul(r, w)
	u2.Mod(u2, c.n)

	x1, y1 := c.scalarMult(c.gx, c.gy, u1.Bytes())
	x2, y2 := c.scalarMult(x, y, u2.Bytes())
	var p1, p2 k1Point
	p1 = k1Point{big.NewInt(0), big.NewInt(1), big.NewInt(0)}
	p2 = p1
	if x1 != nil {
		p1 = k1Point{x1, y1, big.NewInt(1)}
	}
	if x2 != nil {
		p2 = k1Point{x2, y2, big.NewInt(1)}
	}
	sx, _ := c.affine(c.add(p1, p2))
	if sx == nil {
		return false
	}
	return sx.Mod(sx, c.n).Cmp(r) == 0
}
