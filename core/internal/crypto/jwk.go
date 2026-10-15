package crypto

import (
	"crypto/rsa"
	"encoding/base64"
	"fmt"
	"math/big"
	"strings"
)

var okpCurves = map[string]string{"Ed25519": "ed25519", "Ed448": "ed448", "X25519": "x25519", "X448": "x448"}

func b64url(b []byte) string {
	return base64.RawURLEncoding.EncodeToString(b)
}

func received(v any) string {
	switch v := v.(type) {
	case nil:
		return "undefined"
	case string:
		return "'" + v + "'"
	}
	return fmt.Sprint(v)
}

// jwkBytes reads a base64url member, Node's errors for a missing one
func jwkBytes(jwk map[string]any, name string) ([]byte, error) {
	s, ok := jwk[name].(string)
	if !ok {
		return nil, errJwkProperty(name)
	}
	b, err := base64.RawURLEncoding.DecodeString(strings.TrimRight(s, "="))
	if err != nil {
		return nil, errInvalidJwk("data")
	}
	return b, nil
}

func jwkInts(jwk map[string]any, names ...string) ([]*big.Int, error) {
	out := make([]*big.Int, len(names))
	for i, name := range names {
		b, err := jwkBytes(jwk, name)
		if err != nil {
			return nil, err
		}
		out[i] = new(big.Int).SetBytes(b)
	}
	return out, nil
}

func parseJWK(jwk map[string]any, wantPublic bool) (*asymKey, error) {
	_, hasD := jwk["d"]
	private := !wantPublic || hasD

	switch kty := jwk["kty"]; kty {
	case "RSA":
		return parseRSAJWK(jwk, private)
	case "EC":
		crv, _ := jwk["crv"].(string)
		curve := curveByJwk(crv)
		if curve == nil {
			return nil, newTypeError("ERR_INVALID_ARG_VALUE", "The property 'key.crv' must be one of: 'P-256', 'secp256k1', 'P-384', 'P-521'. Received "+received(jwk["crv"]))
		}
		return parseECJWK(jwk, curve, private)
	case "OKP":
		crv, _ := jwk["crv"].(string)
		kind := okpCurves[crv]
		if kind == "" {
			return nil, newTypeError("ERR_INVALID_ARG_VALUE", "The property 'key.crv' must be one of: 'Ed25519', 'Ed448', 'X25519', 'X448'. Received "+received(jwk["crv"]))
		}
		if private {
			d, err := jwkBytes(jwk, "d")
			if err != nil {
				return nil, err
			}
			// seeds are the size of the public keys
			if len(d) != okpPublicSize[kind] {
				return nil, errInvalidJwk("data")
			}
			k, err := okpPrivate(kind, d)
			if err != nil {
				return nil, errInvalidJwk("data")
			}
			return k, nil
		}
		x, err := jwkBytes(jwk, "x")
		if err != nil {
			return nil, err
		}
		if len(x) != okpPublicSize[kind] {
			return nil, errInvalidJwk("data")
		}
		return &asymKey{kind: kind, pub: x}, nil
	case "AKP":
		return nil, errDecoderUnsupported
	default:
		return nil, newTypeError("ERR_INVALID_ARG_VALUE", "The property 'key.kty' must be one of: 'RSA', 'EC', 'OKP', 'AKP'. Received "+received(kty))
	}
}

func parseRSAJWK(jwk map[string]any, private bool) (*asymKey, error) {
	ne, err := jwkInts(jwk, "n", "e")
	if err != nil {
		return nil, err
	}
	if ne[0].Sign() == 0 || !ne[1].IsInt64() || ne[1].Int64() < 3 || ne[1].Int64() > 1<<31-1 {
		return nil, errInvalidJwk("RSA key")
	}
	pub := &rsa.PublicKey{N: ne[0], E: int(ne[1].Int64())}
	if !private {
		return &asymKey{kind: "rsa", rsaPub: pub}, nil
	}

	v, err := jwkInts(jwk, "d", "p", "q", "dp", "dq", "qi")
	if err != nil {
		return nil, err
	}
	key := &rsa.PrivateKey{PublicKey: *pub, D: v[0], Primes: []*big.Int{v[1], v[2]}}
	key.Precompute()
	if key.Validate() != nil || key.Precomputed.Dp.Cmp(v[3]) != 0 || key.Precomputed.Dq.Cmp(v[4]) != 0 || key.Precomputed.Qinv.Cmp(v[5]) != 0 {
		return nil, errInvalidJwk("RSA key")
	}
	return &asymKey{kind: "rsa", private: true, rsa: key, rsaPub: &key.PublicKey}, nil
}

func parseECJWK(jwk map[string]any, curve *ecCurve, private bool) (*asymKey, error) {
	x, err := jwkBytes(jwk, "x")
	if err != nil {
		return nil, err
	}
	y, err := jwkBytes(jwk, "y")
	if err != nil {
		return nil, err
	}
	if len(x) > curve.size || len(y) > curve.size {
		return nil, errInvalidJwk("EC key")
	}
	point := make([]byte, 1+2*curve.size)
	point[0] = 4
	copy(point[1+curve.size-len(x):], x)
	copy(point[1+2*curve.size-len(y):], y)
	if !curve.validPoint(point) {
		return nil, errInvalidJwk("EC key")
	}
	if !private {
		return &asymKey{kind: "ec", curve: curve, point: point}, nil
	}

	d, err := jwkBytes(jwk, "d")
	if err != nil {
		return nil, err
	}
	k, err := ecPrivate(curve, d)
	if err != nil || string(k.point) != string(point) {
		return nil, errInvalidJwk("EC key")
	}
	return k, nil
}

// exportJWK keeps the member order of Node's output
func exportJWK(k *asymKey) (any, error) {
	switch k.kind {
	case "rsa":
		o := jsonObject{{"kty", "RSA"}, {"n", b64url(k.rsaPub.N.Bytes())}, {"e", b64url(big.NewInt(int64(k.rsaPub.E)).Bytes())}}
		if k.private {
			pc := k.rsa.Precomputed
			o = append(o,
				[2]string{"d", b64url(k.rsa.D.Bytes())},
				[2]string{"p", b64url(k.rsa.Primes[0].Bytes())},
				[2]string{"q", b64url(k.rsa.Primes[1].Bytes())},
				[2]string{"dp", b64url(pc.Dp.Bytes())},
				[2]string{"dq", b64url(pc.Dq.Bytes())},
				[2]string{"qi", b64url(pc.Qinv.Bytes())},
			)
		}
		return o, nil
	case "ec":
		if k.curve.jwk == "" {
			return nil, newError("ERR_CRYPTO_JWK_UNSUPPORTED_CURVE", "Unsupported JWK EC curve: "+k.curve.name+".")
		}
		size := k.curve.size
		o := jsonObject{{"kty", "EC"}, {"x", b64url(k.point[1 : 1+size])}, {"y", b64url(k.point[1+size:])}, {"crv", k.curve.jwk}}
		if k.private {
			o = append(o, [2]string{"d", b64url(k.scalar)})
		}
		return o, nil
	case "ed25519", "ed448", "x25519", "x448":
		var crv string
		for name, kind := range okpCurves {
			if kind == k.kind {
				crv = name
			}
		}
		o := jsonObject{{"crv", crv}}
		if k.private {
			o = append(o, [2]string{"d", b64url(k.seed)})
		}
		return append(o, [2]string{"x", b64url(k.pub)}, [2]string{"kty", "OKP"}), nil
	}
	return nil, errJwkUnsupportedType
}
