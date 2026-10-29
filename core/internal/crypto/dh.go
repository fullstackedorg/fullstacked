package crypto

import (
	"crypto/ecdh"
	"crypto/rand"
	"encoding/binary"
	"encoding/hex"
	"fullstackedorg/fullstacked/types"
	"math/big"
	"strings"

	"github.com/cloudflare/circl/dh/x448"
)

// diffieHellman: privateDer (PKCS#8), publicDer (SPKI) -> shared secret,
// Node's crypto.diffieHellman for x25519, x448 and ec keys
func diffieHellman(_ *types.Context, a args) (any, error) {
	priv, err := loadKey(a.buf(0))
	if err != nil {
		return nil, err
	}
	pub, err := loadKey(a.buf(1))
	if err != nil {
		return nil, err
	}

	if priv.kind != pub.kind || (priv.kind != "x25519" && priv.kind != "x448" && priv.kind != "ec") {
		return nil, newError("ERR_CRYPTO_INCOMPATIBLE_KEY", "Incompatible key types for Diffie-Hellman: "+priv.kind+" and "+pub.kind)
	}
	if !priv.private {
		return nil, errDecoderUnsupported
	}

	switch priv.kind {
	case "x25519":
		pk, err := ecdh.X25519().NewPublicKey(pub.pub)
		if err != nil {
			return nil, errDerivationFailed
		}
		secret, err := priv.x25519Key.ECDH(pk)
		if err != nil {
			return nil, errDerivationFailed
		}
		return secret, nil
	case "x448":
		var shared, secret, public x448.Key
		copy(secret[:], priv.seed)
		copy(public[:], pub.pub)
		if !x448.Shared(&shared, &secret, &public) {
			return nil, errDerivationFailed
		}
		return shared[:], nil
	}

	if priv.curve != pub.curve {
		return nil, errMismatchingDomain
	}
	secret, err := priv.curve.sharedSecret(priv.scalar, pub.point)
	if err != nil {
		return nil, errDerivationFailed
	}
	return secret, nil
}

// --- classic Diffie-Hellman (createDiffieHellman, getDiffieHellman) ---
//
// math/big modular exponentiation, NOT constant time. Node keeps these
// for compatibility (ssh's diffie-hellman-group*), X25519 and ECDH are the
// constant-time options.

// dhGroup: name -> prime, the generator is 2 for all of them
func dhGroup(_ *types.Context, a args) (any, error) {
	group, ok := dhGroups[a.str(0)]
	if !ok {
		return nil, errUnknownDhGroup
	}
	return hex.DecodeString(group.prime)
}

// dhPrivateBits is the private key length of a known group, the prime
// size - 1 otherwise (OpenSSL's choice for both)
func dhPrivateBits(prime []byte) int {
	p := hex.EncodeToString(prime)
	for _, group := range dhGroups {
		if group.privateBits != 0 && strings.EqualFold(group.prime, p) {
			return group.privateBits
		}
	}
	return new(big.Int).SetBytes(prime).BitLen() - 1
}

// dhGenerate: prime, generator, privateKey? -> 4 bytes length of the public
// key, the public key, the private key (both unpadded, like Node's getters)
func dhGenerate(_ *types.Context, a args) (any, error) {
	prime := a.buf(0)
	p := new(big.Int).SetBytes(prime)
	g := new(big.Int).SetBytes(a.buf(1))
	if g.Cmp(big.NewInt(2)) < 0 || g.Cmp(p) >= 0 {
		return nil, errDhBadGenerator
	}

	var x *big.Int
	if a.defined(2) {
		x = new(big.Int).SetBytes(a.buf(2))
	} else {
		bits := dhPrivateBits(prime)
		if bits < 2 {
			return nil, newError("ERR_CRYPTO_OPERATION_FAILED", "Key generation failed")
		}
		limit := new(big.Int).Lsh(big.NewInt(1), uint(bits))
		for {
			var err error
			if x, err = rand.Int(rand.Reader, limit); err != nil {
				return nil, err
			}
			if x.Cmp(big.NewInt(1)) > 0 {
				break
			}
		}
	}

	public := new(big.Int).Exp(g, x, p).Bytes()
	out := make([]byte, 4, 4+len(public)+len(x.Bytes()))
	binary.BigEndian.PutUint32(out, uint32(len(public)))
	out = append(out, public...)
	return append(out, x.Bytes()...), nil
}

// dhCompute: prime, privateKey, otherPublicKey -> secret, zero padded to
// the size of the prime as Node returns it
func dhCompute(_ *types.Context, a args) (any, error) {
	prime := a.buf(0)
	p := new(big.Int).SetBytes(prime)
	x := new(big.Int).SetBytes(a.buf(1))
	y := new(big.Int).SetBytes(a.buf(2))

	if y.Cmp(big.NewInt(1)) <= 0 {
		return nil, errDhKeyTooSmall
	}
	if y.Cmp(new(big.Int).Sub(p, big.NewInt(1))) >= 0 {
		return nil, errDhKeyTooLarge
	}
	return new(big.Int).Exp(y, x, p).FillBytes(make([]byte, (p.BitLen()+7)/8)), nil
}

// --- ECDH (createECDH) ---

// ecdhGenerate: curve, privateKey? -> 4 bytes length of the public key, the
// uncompressed public key, the private key padded to the curve size
func ecdhGenerate(_ *types.Context, a args) (any, error) {
	curve := curveByName(a.str(0))
	if curve == nil {
		return nil, errInvalidCurve
	}

	var scalar, point []byte
	var err error
	if a.defined(1) {
		var ok bool
		if scalar, ok = curve.scalar(a.buf(1)); !ok {
			return nil, errInvalidPrivateEcdh
		}
		point, err = curve.publicKey(scalar)
	} else {
		scalar, point, err = curve.generate()
	}
	if err != nil {
		return nil, err
	}

	out := make([]byte, 4, 4+len(point)+len(scalar))
	binary.BigEndian.PutUint32(out, uint32(len(point)))
	out = append(out, point...)
	return append(out, scalar...), nil
}

// ecdhCompute: curve, privateKey, otherPublicKey (any encoding) -> secret
func ecdhCompute(_ *types.Context, a args) (any, error) {
	curve := curveByName(a.str(0))
	if curve == nil {
		return nil, errInvalidCurve
	}
	scalar, ok := curve.scalar(a.buf(1))
	if !ok {
		return nil, errInvalidPrivateEcdh
	}
	point, ok := curve.decodePoint(a.buf(2))
	if !ok {
		return nil, errInvalidPublicPoint
	}
	secret, err := curve.sharedSecret(scalar, point)
	if err != nil {
		return nil, errInvalidPublicPoint
	}
	return secret, nil
}

// ecdhConvertKey: curve, key (any encoding), format -> point
func ecdhConvertKey(_ *types.Context, a args) (any, error) {
	curve := curveByName(a.str(0))
	if curve == nil {
		return nil, errInvalidCurve
	}
	point, ok := curve.decodePoint(a.buf(1))
	if !ok {
		return nil, newError("ERR_CRYPTO_OPERATION_FAILED", "Failed to convert Buffer to EC_POINT")
	}
	switch format := a.str(2); format {
	case "compressed", "uncompressed", "hybrid":
		return curve.encodePoint(point, format), nil
	default:
		return nil, newTypeError("ERR_CRYPTO_ECDH_INVALID_FORMAT", "Invalid ECDH format: "+format)
	}
}
