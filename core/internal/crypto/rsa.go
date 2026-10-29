package crypto

import (
	"crypto/hmac"
	"crypto/rand"
	"crypto/rsa"
	"crypto/sha256"
	"crypto/subtle"
	"errors"
	"fullstackedorg/fullstacked/types"
	"math/big"
)

// Node's padding constants
const (
	rsaPKCS1Padding = 1
	rsaNoPadding    = 3
	rsaOAEPPadding  = 4
	rsaPSSPadding   = 6
)

func rsaSize(pub *rsa.PublicKey) int {
	return (pub.N.BitLen() + 7) / 8
}

// rsaPublicRaw is m^e mod n, public data only
func rsaPublicRaw(pub *rsa.PublicKey, data []byte) ([]byte, error) {
	m := new(big.Int).SetBytes(data)
	if m.Cmp(pub.N) >= 0 {
		return nil, errTooLargeForModulus
	}
	c := new(big.Int).Exp(m, big.NewInt(int64(pub.E)), pub.N)
	return c.FillBytes(make([]byte, rsaSize(pub))), nil
}

// rsaPrivateRaw is c^d mod n for what Go's rsa package has no API for: no
// padding at all, and PSS with a salt of 0 or an MGF1 digest other than
// the message digest. It is math/big with blinding, NOT constant time; the
// padded operations go through crypto/rsa.
func rsaPrivateRaw(priv *rsa.PrivateKey, data []byte) ([]byte, error) {
	n := priv.N
	c := new(big.Int).SetBytes(data)
	if c.Cmp(n) >= 0 {
		return nil, errTooLargeForModulus
	}
	e := big.NewInt(int64(priv.E))

	var r, rInv *big.Int
	for {
		var err error
		r, err = rand.Int(rand.Reader, n)
		if err != nil {
			return nil, err
		}
		if r.Sign() == 0 {
			continue
		}
		if rInv = new(big.Int).ModInverse(r, n); rInv != nil {
			break
		}
	}
	blinded := new(big.Int).Exp(r, e, n)
	blinded.Mul(blinded, c).Mod(blinded, n)

	var m *big.Int
	pc := priv.Precomputed
	if len(priv.Primes) == 2 && pc.Dp != nil {
		p, q := priv.Primes[0], priv.Primes[1]
		m1 := new(big.Int).Exp(blinded, pc.Dp, p)
		m2 := new(big.Int).Exp(blinded, pc.Dq, q)
		h := m1.Sub(m1, m2)
		h.Mul(h, pc.Qinv).Mod(h, p)
		m = h.Mul(h, q).Add(h, m2)
	} else {
		m = new(big.Int).Exp(blinded, priv.D, n)
	}
	m.Mul(m, rInv).Mod(m, n)

	// a fault in the CRT path would leak a factor of n
	if new(big.Int).Exp(m, e, n).Cmp(c) != 0 {
		return nil, errors.New("rsa: internal error")
	}
	return m.FillBytes(make([]byte, rsaSize(&priv.PublicKey))), nil
}

func mgf1XOR(out, seed []byte, d *digest) {
	var counter [4]byte
	done := 0
	for done < len(out) {
		h := d.new()
		h.Write(seed)
		h.Write(counter[:])
		for _, b := range h.Sum(nil) {
			if done >= len(out) {
				break
			}
			out[done] ^= b
			done++
		}
		for i := 3; i >= 0; i-- {
			if counter[i]++; counter[i] != 0 {
				break
			}
		}
	}
}

// emsaPSSEncode is RFC 8017 9.1.1 with separate message and MGF1 digests
func emsaPSSEncode(mHash []byte, emBits int, salt []byte, hash, mgf *digest) ([]byte, error) {
	hLen, sLen := hash.size, len(salt)
	emLen := (emBits + 7) / 8
	if emLen < hLen+sLen+2 {
		return nil, errTooLargeForKey
	}

	h := hash.new()
	h.Write(make([]byte, 8))
	h.Write(mHash)
	h.Write(salt)
	H := h.Sum(nil)

	em := make([]byte, emLen)
	db := em[:emLen-hLen-1]
	db[emLen-sLen-hLen-2] = 1
	copy(db[emLen-sLen-hLen-1:], salt)
	mgf1XOR(db, H, mgf)
	db[0] &= 0xff >> (8*emLen - emBits)
	copy(em[emLen-hLen-1:], H)
	em[emLen-1] = 0xbc
	return em, nil
}

// emsaPSSVerify is RFC 8017 9.1.2, saltLen < 0 recovers the salt length
func emsaPSSVerify(mHash, em []byte, emBits, saltLen int, hash, mgf *digest) bool {
	hLen := hash.size
	emLen := (emBits + 7) / 8
	if len(em) != emLen || emLen < hLen+2 || em[emLen-1] != 0xbc {
		return false
	}
	db := append([]byte(nil), em[:emLen-hLen-1]...)
	H := em[emLen-hLen-1 : emLen-1]
	if db[0]&^(0xff>>(8*emLen-emBits)) != 0 {
		return false
	}
	mgf1XOR(db, H, mgf)
	db[0] &= 0xff >> (8*emLen - emBits)

	psLen := 0
	for psLen < len(db) && db[psLen] == 0 {
		psLen++
	}
	if psLen == len(db) || db[psLen] != 1 {
		return false
	}
	salt := db[psLen+1:]
	if saltLen >= 0 && len(salt) != saltLen {
		return false
	}

	h := hash.new()
	h.Write(make([]byte, 8))
	h.Write(mHash)
	h.Write(salt)
	return subtle.ConstantTimeCompare(h.Sum(nil), H) == 1
}

// pssSaltLength resolves Node's salt lengths: -1 the digest size, -2 the
// maximum when signing (auto, returned as -1, when verifying)
func pssSaltLength(saltLen int, pub *rsa.PublicKey, hash *digest, signing bool) (int, error) {
	emLen := (pub.N.BitLen() - 1 + 7) / 8
	max := emLen - hash.size - 2
	switch {
	case saltLen == -1:
		saltLen = hash.size
	case saltLen <= -2:
		if !signing {
			return -1, nil
		}
		saltLen = max
	}
	if saltLen > max {
		return 0, errTooLargeForKey
	}
	return saltLen, nil
}

func signPSS(priv *rsa.PrivateKey, mHash []byte, hash, mgf *digest, saltLen int) ([]byte, error) {
	saltLen, err := pssSaltLength(saltLen, &priv.PublicKey, hash, true)
	if err != nil {
		return nil, err
	}
	if mgf == hash && saltLen > 0 && hash.id != 0 {
		return rsa.SignPSS(rand.Reader, priv, hash.id, mHash, &rsa.PSSOptions{SaltLength: saltLen})
	}

	salt := make([]byte, saltLen)
	rand.Read(salt)
	em, err := emsaPSSEncode(mHash, priv.N.BitLen()-1, salt, hash, mgf)
	if err != nil {
		return nil, err
	}
	return rsaPrivateRaw(priv, em)
}

func verifyPSS(pub *rsa.PublicKey, mHash, sig []byte, hash, mgf *digest, saltLen int) bool {
	saltLen, err := pssSaltLength(saltLen, pub, hash, false)
	if err != nil || len(sig) != rsaSize(pub) {
		return false
	}
	if mgf == hash && saltLen != 0 && hash.id != 0 {
		opts := &rsa.PSSOptions{SaltLength: saltLen}
		if saltLen < 0 {
			opts.SaltLength = rsa.PSSSaltLengthAuto
		}
		return rsa.VerifyPSS(pub, hash.id, mHash, sig, opts) == nil
	}

	m, err := rsaPublicRaw(pub, sig)
	if err != nil {
		return false
	}
	emBits := pub.N.BitLen() - 1
	emLen := (emBits + 7) / 8
	if len(m) > emLen {
		if m[0] != 0 {
			return false
		}
		m = m[1:]
	}
	return emsaPSSVerify(mHash, m, emBits, saltLen, hash, mgf)
}

// rsaImplicitRejection is the message OpenSSL returns instead of an error
// when PKCS#1 v1.5 decryption padding is wrong (Marvin attack
// countermeasure, Node 24 relies on it): a pseudo-random message derived
// from the private exponent and the ciphertext
func rsaImplicitRejection(priv *rsa.PrivateKey, ciphertext []byte) []byte {
	k := rsaSize(&priv.PublicKey)
	dHash := sha256.Sum256(priv.D.FillBytes(make([]byte, k)))
	mac := hmac.New(sha256.New, dHash[:])
	mac.Write(ciphertext) // already padded to k
	kdk := mac.Sum(nil)

	prf := func(label string, n int) []byte {
		out := make([]byte, 0, n+sha256.Size)
		bits := []byte{byte(n * 8 >> 8), byte(n * 8)}
		for i := 0; len(out) < n; i++ {
			h := hmac.New(sha256.New, kdk)
			h.Write([]byte{byte(i >> 8), byte(i)})
			h.Write([]byte(label))
			h.Write(bits)
			out = h.Sum(out)
		}
		return out[:n]
	}

	synthetic := prf("message", k)
	candidates := prf("length", 256)
	maxSepOffset := k - 2 - 8
	mask := maxSepOffset
	mask |= mask >> 1
	mask |= mask >> 2
	mask |= mask >> 4
	mask |= mask >> 8

	length := 0
	for i := 0; i < len(candidates); i += 2 {
		candidate := (int(candidates[i])<<8 | int(candidates[i+1])) & mask
		length = subtle.ConstantTimeSelect(subtle.ConstantTimeLessOrEq(candidate+1, maxSepOffset), candidate, length)
	}
	return synthetic[k-length:]
}

func rsaDecryptPKCS1(priv *rsa.PrivateKey, ciphertext []byte) ([]byte, error) {
	k := rsaSize(&priv.PublicKey)
	if len(ciphertext) > k {
		return nil, newError("ERR_OSSL_RSA_DATA_GREATER_THAN_MOD_LEN", "error:0200006C:rsa routines::data greater than mod len")
	}
	padded := make([]byte, k)
	copy(padded[k-len(ciphertext):], ciphertext)
	if new(big.Int).SetBytes(padded).Cmp(priv.N) >= 0 {
		return nil, errTooLargeForModulus
	}

	synthetic := rsaImplicitRejection(priv, padded)
	plaintext, err := rsa.DecryptPKCS1v15(nil, priv, padded)
	if err != nil {
		return synthetic, nil
	}
	return plaintext, nil
}

// rsaCrypt: operation, der, data, padding, oaepHash?, oaepLabel?
func rsaCrypt(_ *types.Context, a args) (any, error) {
	k, err := loadKey(a.buf(1))
	if err != nil {
		return nil, err
	}
	switch k.kind {
	case "rsa":
	case "rsa-pss":
		return nil, errProviderNotForKey
	default:
		return nil, errNotForKeyType
	}

	operation, data, padding := a.str(0), a.buf(2), a.int(3, rsaPKCS1Padding)
	pub := k.rsaPub
	size := rsaSize(pub)

	oaepHash := digests["sha1"]
	if a.defined(4) {
		if oaepHash = digests[a.str(4)]; oaepHash == nil || oaepHash.new == nil {
			return nil, errInvalidOaepDigest
		}
	}
	label := a.buf(5)

	rawSize := func() error {
		if len(data) < size {
			return errTooSmallForKey
		}
		if len(data) > size {
			return errTooLargeForKey
		}
		return nil
	}

	switch operation {
	case "publicEncrypt":
		switch padding {
		case rsaPKCS1Padding:
			if len(data) > size-11 {
				return nil, errTooLargeForKey
			}
			return rsa.EncryptPKCS1v15(rand.Reader, pub, data)
		case rsaOAEPPadding:
			if len(data) > size-2*oaepHash.size-2 {
				return nil, errTooLargeForKey
			}
			return rsa.EncryptOAEP(oaepHash.new(), rand.Reader, pub, data, label)
		case rsaNoPadding:
			if err := rawSize(); err != nil {
				return nil, err
			}
			return rsaPublicRaw(pub, data)
		}
	case "publicDecrypt":
		switch padding {
		case rsaPKCS1Padding, rsaNoPadding:
			if len(data) > size {
				return nil, newError("ERR_OSSL_RSA_DATA_GREATER_THAN_MOD_LEN", "error:0200006C:rsa routines::data greater than mod len")
			}
			em, err := rsaPublicRaw(pub, data)
			if err != nil || padding == rsaNoPadding {
				return em, err
			}
			// type 1: 00 01 FF..FF 00 data, at least 8 FF
			if em[0] != 0 || em[1] != 1 {
				return nil, errRsaInvalidPadding
			}
			i := 2
			for i < len(em) && em[i] == 0xff {
				i++
			}
			if i == len(em) || em[i] != 0 || i < 10 {
				return nil, errRsaInvalidPadding
			}
			return em[i+1:], nil
		}
	case "privateDecrypt", "privateEncrypt":
		if !k.private {
			return nil, errDecoderUnsupported
		}
		priv := k.rsa
		if operation == "privateEncrypt" {
			switch padding {
			case rsaPKCS1Padding:
				if len(data) > size-11 {
					return nil, errTooLargeForKey
				}
				// a PKCS#1 v1.5 signature of the raw data, type 1 padding
				return rsa.SignPKCS1v15(nil, priv, 0, data)
			case rsaNoPadding:
				if err := rawSize(); err != nil {
					return nil, err
				}
				return rsaPrivateRaw(priv, data)
			}
			break
		}
		switch padding {
		case rsaPKCS1Padding:
			return rsaDecryptPKCS1(priv, data)
		case rsaOAEPPadding:
			if len(data) == size && new(big.Int).SetBytes(data).Cmp(pub.N) >= 0 {
				return nil, errTooLargeForModulus
			}
			out, err := rsa.DecryptOAEP(oaepHash.new(), nil, priv, data, label)
			if err != nil {
				return nil, errOaepDecoding
			}
			return out, nil
		case rsaNoPadding:
			if len(data) > size {
				return nil, newError("ERR_OSSL_RSA_DATA_GREATER_THAN_MOD_LEN", "error:0200006C:rsa routines::data greater than mod len")
			}
			return rsaPrivateRaw(priv, data)
		case rsaPSSPadding:
			return nil, newError("", "error:00000000:lib(0)::reason(0)")
		}
	default:
		return nil, newTypeError("ERR_INVALID_ARG_VALUE", "unknown RSA operation "+operation)
	}
	return nil, errIllegalPadding
}
