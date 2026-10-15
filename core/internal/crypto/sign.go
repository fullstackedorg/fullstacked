package crypto

import (
	"crypto/ed25519"
	"crypto/rsa"
	"fullstackedorg/fullstacked/types"

	"github.com/cloudflare/circl/sign/ed448"
	"golang.org/x/crypto/cryptobyte"
	cbasn1 "golang.org/x/crypto/cryptobyte/asn1"
)

type signOptions struct {
	Padding     *int   `json:"padding"`
	SaltLength  *int   `json:"saltLength"`
	DsaEncoding string `json:"dsaEncoding"`
}

// signParams resolves the digest and padding of a sign or verify the way
// OpenSSL 3 does for Node: no algorithm means SHA-256 (the default digest
// of RSA and EC keys), and an RSA-PSS key with parameters imposes its
// digests and a minimum salt length.
type signParams struct {
	hash    *digest
	mgf1    *digest
	pss     bool
	saltLen int
	p1363   bool
}

func resolveSign(k *asymKey, algorithm string, hasAlgorithm bool, o *signOptions) (*signParams, error) {
	p := &signParams{p1363: o.DsaEncoding == "ieee-p1363"}

	switch k.kind {
	case "ed25519", "ed448":
		if hasAlgorithm {
			return nil, errInvalidDigestForKey
		}
		return p, nil
	case "x25519", "x448":
		return nil, errNotForKeyType
	}

	p.hash = digests["sha256"]
	if k.pss != nil {
		p.hash = k.pss.hash
	}
	if hasAlgorithm {
		if p.hash = digests[algorithm]; p.hash == nil {
			return nil, errInvalidDigest(algorithm)
		}
	}

	if !k.isRSA() {
		return p, nil
	}

	padding := rsaPKCS1Padding
	if k.kind == "rsa-pss" {
		padding = rsaPSSPadding
	}
	if o.Padding != nil {
		padding = *o.Padding
	}
	switch padding {
	case rsaPKCS1Padding:
		if k.kind == "rsa-pss" {
			return nil, errIllegalPadding
		}
	case rsaPSSPadding:
		p.pss = true
	default:
		return nil, errInvalidPaddingMode
	}

	if !p.pss {
		return p, nil
	}
	if p.hash.new == nil {
		return nil, errInvalidDigestForKey
	}

	p.mgf1 = p.hash
	// Node's default: the maximum salt when signing, auto when verifying
	p.saltLen = -2
	if k.pss != nil {
		if p.hash != k.pss.hash {
			return nil, errDigestNotAllowed
		}
		p.mgf1 = k.pss.mgf1
		p.saltLen = k.pss.saltLen
	}
	if o.SaltLength != nil {
		p.saltLen = *o.SaltLength
		if k.pss != nil {
			resolved, err := pssSaltLength(p.saltLen, k.rsaPub, p.hash, true)
			if err == nil && resolved < k.pss.saltLen {
				return nil, errPssSaltTooSmall
			}
		}
	}
	return p, nil
}

// digestInfo is the DER PKCS#1 v1.5 signs: the digest OID then the digest
func digestInfo(d *digest, sum []byte) []byte {
	var b cryptobyte.Builder
	b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
		b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
			b.AddASN1ObjectIdentifier(d.oid)
			b.AddASN1NULL()
		})
		b.AddASN1OctetString(sum)
	})
	return b.BytesOrPanic()
}

func readSignArgs(a args, signing bool) (*asymKey, *signParams, error) {
	k, err := loadKey(a.buf(2))
	if err != nil {
		return nil, nil, err
	}
	if signing && !k.private {
		return nil, nil, errDecoderUnsupported
	}

	var o signOptions
	optionsIndex := 3
	if !signing {
		optionsIndex = 4
	}
	if err := a.object(optionsIndex, &o); err != nil {
		return nil, nil, err
	}

	p, err := resolveSign(k, a.str(0), a.defined(0), &o)
	return k, p, err
}

// sign: algorithm?, data, der (PKCS#8), options -> signature
func sign(_ *types.Context, a args) (any, error) {
	k, p, err := readSignArgs(a, true)
	if err != nil {
		return nil, err
	}
	data := a.buf(1)

	switch k.kind {
	case "ed25519":
		return ed25519.Sign(k.ed25519Key, data), nil
	case "ed448":
		return ed448.Sign(ed448.NewKeyFromSeed(k.seed), data, ""), nil
	case "ec":
		sig, err := k.curve.sign(k.scalar, p.hash.sum(data))
		if err != nil || !p.p1363 {
			return sig, err
		}
		return k.curve.toP1363(sig)
	}

	sum := p.hash.sum(data)
	if p.pss {
		return signPSS(k.rsa, sum, p.hash, p.mgf1, p.saltLen)
	}
	sig, err := rsa.SignPKCS1v15(nil, k.rsa, 0, digestInfo(p.hash, sum))
	if err != nil {
		return nil, newError("ERR_OSSL_RSA_DIGEST_TOO_BIG_FOR_RSA_KEY", "error:02000070:rsa routines::digest too big for rsa key")
	}
	return sig, nil
}

// verify: algorithm?, data, der (SPKI or PKCS#8), signature, options -> bool
func verify(_ *types.Context, a args) (any, error) {
	k, p, err := readSignArgs(a, false)
	if err != nil {
		return nil, err
	}
	data, sig := a.buf(1), a.buf(3)

	switch k.kind {
	case "ed25519":
		return len(sig) == ed25519.SignatureSize && ed25519.Verify(k.pub, data, sig), nil
	case "ed448":
		return len(sig) == ed448.SignatureSize && ed448.Verify(k.pub, data, sig, ""), nil
	case "ec":
		if p.p1363 {
			var ok bool
			if sig, ok = k.curve.fromP1363(sig); !ok {
				return false, nil
			}
		}
		return k.curve.verify(k.point, p.hash.sum(data), sig), nil
	}

	sum := p.hash.sum(data)
	if p.pss {
		return verifyPSS(k.rsaPub, sum, sig, p.hash, p.mgf1, p.saltLen), nil
	}
	return rsa.VerifyPKCS1v15(k.rsaPub, 0, digestInfo(p.hash, sum), sig) == nil, nil
}
