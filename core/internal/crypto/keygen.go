package crypto

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"fullstackedorg/fullstacked/types"
	"math/big"

	"github.com/cloudflare/circl/dh/x448"
	"github.com/cloudflare/circl/sign/ed448"
)

type keyGenOptions struct {
	ModulusLength     int      `json:"modulusLength"`
	PublicExponent    *float64 `json:"publicExponent"`
	HashAlgorithm     string   `json:"hashAlgorithm"`
	Mgf1HashAlgorithm string   `json:"mgf1HashAlgorithm"`
	SaltLength        *int     `json:"saltLength"`
	NamedCurve        string   `json:"namedCurve"`
	// Node's deprecated names
	Hash     string `json:"hash"`
	Mgf1Hash string `json:"mgf1Hash"`
}

// keyGenerate: type, options -> { publicKey: SPKI, privateKey: PKCS#8 },
// both base64
func keyGenerate(_ *types.Context, a args) (any, error) {
	var o keyGenOptions
	if err := a.object(1, &o); err != nil {
		return nil, newTypeError("ERR_INVALID_ARG_TYPE", "The \"options\" argument must be of type object.")
	}

	var k *asymKey
	var err error
	switch typ := a.str(0); typ {
	case "rsa", "rsa-pss":
		k, err = generateRSA(typ, &o)
	case "ec":
		curve := curveByName(o.NamedCurve)
		if curve == nil {
			return nil, errInvalidCurve
		}
		scalar, point, genErr := curve.generate()
		if genErr != nil {
			return nil, genErr
		}
		k = &asymKey{kind: "ec", private: true, curve: curve, scalar: scalar, point: point}
	case "ed25519":
		_, priv, genErr := ed25519.GenerateKey(rand.Reader)
		if genErr != nil {
			return nil, genErr
		}
		k, err = okpPrivate(typ, priv.Seed())
	case "ed448":
		_, priv, genErr := ed448.GenerateKey(rand.Reader)
		if genErr != nil {
			return nil, genErr
		}
		k, err = okpPrivate(typ, priv.Seed())
	case "x25519":
		priv, genErr := ecdh.X25519().GenerateKey(rand.Reader)
		if genErr != nil {
			return nil, genErr
		}
		k, err = okpPrivate(typ, priv.Bytes())
	case "x448":
		var secret x448.Key
		rand.Read(secret[:])
		k, err = okpPrivate(typ, secret[:])
	case "dsa", "dh", "ml-dsa-44", "ml-dsa-65", "ml-dsa-87", "ml-kem-512", "ml-kem-768", "ml-kem-1024":
		return nil, newError("ERR_OSSL_UNSUPPORTED", "error:1E08010C:DECODER routines::unsupported")
	default:
		return nil, newTypeError("ERR_INVALID_ARG_VALUE", "The argument 'type' must be a supported key type. Received '"+typ+"'")
	}
	if err != nil {
		return nil, err
	}

	return map[string]string{
		"publicKey":  base64.StdEncoding.EncodeToString(k.spki()),
		"privateKey": base64.StdEncoding.EncodeToString(k.pkcs8()),
	}, nil
}

func generateRSA(typ string, o *keyGenOptions) (*asymKey, error) {
	if o.ModulusLength < 512 {
		return nil, errRsaKeyTooSmall
	}
	e := 65537
	if o.PublicExponent != nil {
		pe := *o.PublicExponent
		if pe < 3 || pe > 1<<31-1 || pe != float64(int(pe)) || int(pe)%2 == 0 {
			return nil, errRsaBadExponent
		}
		e = int(pe)
	}

	var pss *pssParams
	if typ == "rsa-pss" {
		var err error
		if pss, err = pssKeyParams(o); err != nil {
			return nil, err
		}
	}

	var key *rsa.PrivateKey
	var err error
	if e == 65537 {
		key, err = rsa.GenerateKey(rand.Reader, o.ModulusLength)
	} else {
		key, err = generateRSAExponent(o.ModulusLength, e)
	}
	if err != nil {
		return nil, newError("ERR_CRYPTO_OPERATION_FAILED", "Key generation failed")
	}
	return &asymKey{kind: typ, private: true, rsa: key, rsaPub: &key.PublicKey, pss: pss}, nil
}

// pssKeyParams follows OpenSSL: a key is restricted once any of the three
// is set, the MGF1 digest defaults to the hash, the salt to its size
func pssKeyParams(o *keyGenOptions) (*pssParams, error) {
	hashName, mgf1Name := o.HashAlgorithm, o.Mgf1HashAlgorithm
	if hashName == "" {
		hashName = o.Hash
	}
	if mgf1Name == "" {
		mgf1Name = o.Mgf1Hash
	}
	if hashName == "" && mgf1Name == "" && o.SaltLength == nil {
		return nil, nil
	}

	p := &pssParams{hash: digests["sha1"]}
	if hashName != "" {
		if p.hash = digests[hashName]; p.hash == nil || p.hash.id == 0 {
			return nil, errInvalidDigest(hashName)
		}
	}
	p.mgf1 = p.hash
	if mgf1Name != "" {
		if p.mgf1 = digests[mgf1Name]; p.mgf1 == nil || p.mgf1.id == 0 {
			return nil, errInvalidDigest(mgf1Name)
		}
	}
	p.saltLen = p.hash.size
	if o.SaltLength != nil {
		p.saltLen = *o.SaltLength
	}
	return p, nil
}

// generateRSAExponent covers the public exponents other than 65537, which
// Go's generator does not take. Primes come from crypto/rand.Prime.
func generateRSAExponent(bits, e int) (*rsa.PrivateKey, error) {
	E := big.NewInt(int64(e))
	one := big.NewInt(1)
	for {
		p, err := rand.Prime(rand.Reader, (bits+1)/2)
		if err != nil {
			return nil, err
		}
		q, err := rand.Prime(rand.Reader, bits/2)
		if err != nil {
			return nil, err
		}
		if p.Cmp(q) == 0 {
			continue
		}
		n := new(big.Int).Mul(p, q)
		if n.BitLen() != bits {
			continue
		}
		p1, q1 := new(big.Int).Sub(p, one), new(big.Int).Sub(q, one)
		gcd := new(big.Int).GCD(nil, nil, p1, q1)
		lambda := new(big.Int).Div(new(big.Int).Mul(p1, q1), gcd)
		d := new(big.Int).ModInverse(E, lambda)
		if d == nil {
			continue
		}
		key := &rsa.PrivateKey{PublicKey: rsa.PublicKey{N: n, E: e}, D: d, Primes: []*big.Int{p, q}}
		key.Precompute()
		if key.Validate() != nil {
			continue
		}
		return key, nil
	}
}
