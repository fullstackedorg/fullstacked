package crypto

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/des"
	"crypto/md5"
	"crypto/pbkdf2"
	"crypto/rand"
	"encoding/asn1"
	"encoding/hex"
	"encoding/pem"
	"hash"
	"strings"

	"golang.org/x/crypto/cryptobyte"
	cbasn1 "golang.org/x/crypto/cryptobyte/asn1"
	"golang.org/x/crypto/scrypt"
)

func encodePEM(label string, headers map[string]string, der []byte) string {
	return string(pem.EncodeToMemory(&pem.Block{Type: label, Headers: headers, Bytes: der}))
}

// parsePEM reads the first block that holds what is asked, the way
// OpenSSL's PEM readers skip the others. A public key is looked for as
// SPKI, PKCS#1, certificate, then derived from a private key, like Node's
// createPublicKey.
func parsePEM(text []byte, wantPublic bool, passphrase []byte) (*asymKey, error) {
	var blocks []*pem.Block
	for {
		var block *pem.Block
		block, text = pem.Decode(text)
		if block == nil {
			break
		}
		blocks = append(blocks, block)
	}

	find := func(labels ...string) *pem.Block {
		for _, b := range blocks {
			for _, l := range labels {
				if b.Type == l {
					return b
				}
			}
		}
		return nil
	}

	if wantPublic {
		if b := find("PUBLIC KEY"); b != nil {
			return parseSPKI(b.Bytes)
		}
		if b := find("RSA PUBLIC KEY"); b != nil {
			return parseDER(b.Bytes, "pkcs1", true)
		}
		if b := find("CERTIFICATE"); b != nil {
			spki, err := certificateSPKI(b.Bytes)
			if err != nil {
				return nil, err
			}
			return parseSPKI(spki)
		}
	}

	b := find("PRIVATE KEY", "ENCRYPTED PRIVATE KEY", "RSA PRIVATE KEY", "EC PRIVATE KEY")
	if b == nil {
		return nil, errDecoderUnsupported
	}

	der := b.Bytes
	if b.Headers["Proc-Type"] == "4,ENCRYPTED" {
		if passphrase == nil {
			return nil, errPemNoPassphrase
		}
		var err error
		if der, err = decryptLegacyPEM(b, passphrase); err != nil {
			return nil, err
		}
	}

	switch b.Type {
	case "ENCRYPTED PRIVATE KEY":
		if passphrase == nil {
			return nil, errPemNoPassphrase
		}
		der, err := decryptPKCS8(der, passphrase)
		if err != nil {
			return nil, err
		}
		return parsePKCS8(der)
	case "RSA PRIVATE KEY":
		return parsePKCS1Private(der)
	case "EC PRIVATE KEY":
		return parseSEC1(der, nil)
	}
	return parsePKCS8(der)
}

// certificateSPKI digs the SubjectPublicKeyInfo out of an X.509
// certificate without parsing the rest (any key type Node knows works)
func certificateSPKI(der []byte) ([]byte, error) {
	input := cryptobyte.String(der)
	var cert, tbs, spki cryptobyte.String
	if !input.ReadASN1(&cert, cbasn1.SEQUENCE) || !cert.ReadASN1(&tbs, cbasn1.SEQUENCE) ||
		!tbs.SkipOptionalASN1(cbasn1.Tag(0).Constructed().ContextSpecific()) ||
		!tbs.SkipASN1(cbasn1.INTEGER) || // serial
		!tbs.SkipASN1(cbasn1.SEQUENCE) || // signature algorithm
		!tbs.SkipASN1(cbasn1.SEQUENCE) || // issuer
		!tbs.SkipASN1(cbasn1.SEQUENCE) || // validity
		!tbs.SkipASN1(cbasn1.SEQUENCE) || // subject
		!tbs.ReadASN1Element(&spki, cbasn1.SEQUENCE) {
		return nil, errDecoderUnsupported
	}
	return spki, nil
}

// --- encryption ciphers of keys ---

type keyCipher struct {
	name    string // DEK-Info name
	oid     asn1.ObjectIdentifier
	keyLen  int
	newCiph func([]byte) (cipher.Block, error)
}

var keyCiphers = map[string]*keyCipher{
	"aes-128-cbc":  {"AES-128-CBC", asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 1, 2}, 16, aes.NewCipher},
	"aes-192-cbc":  {"AES-192-CBC", asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 1, 22}, 24, aes.NewCipher},
	"aes-256-cbc":  {"AES-256-CBC", asn1.ObjectIdentifier{2, 16, 840, 1, 101, 3, 4, 1, 42}, 32, aes.NewCipher},
	"des-ede3-cbc": {"DES-EDE3-CBC", asn1.ObjectIdentifier{1, 2, 840, 113549, 3, 7}, 24, des.NewTripleDESCipher},
	"des-cbc":      {"DES-CBC", asn1.ObjectIdentifier{1, 3, 14, 3, 2, 7}, 8, des.NewCipher},
}

func keyCipherByName(dekInfo string) *keyCipher {
	for _, c := range keyCiphers {
		if c.name == dekInfo {
			return c
		}
	}
	return nil
}

func keyCipherByOid(oid asn1.ObjectIdentifier) *keyCipher {
	for _, c := range keyCiphers {
		if c.oid.Equal(oid) {
			return c
		}
	}
	return nil
}

func (c *keyCipher) encrypt(key, iv, data []byte) []byte {
	block, _ := c.newCiph(key)
	bs := block.BlockSize()
	n := bs - len(data)%bs
	padded := append(append([]byte(nil), data...), make([]byte, n)...)
	for i := len(data); i < len(padded); i++ {
		padded[i] = byte(n)
	}
	cipher.NewCBCEncrypter(block, iv).CryptBlocks(padded, padded)
	return padded
}

func (c *keyCipher) decrypt(key, iv, data []byte) ([]byte, error) {
	block, err := c.newCiph(key)
	if err != nil {
		return nil, errBadDecrypt
	}
	bs := block.BlockSize()
	if len(iv) != bs || len(data) == 0 || len(data)%bs != 0 {
		return nil, errBadDecrypt
	}
	out := make([]byte, len(data))
	cipher.NewCBCDecrypter(block, iv).CryptBlocks(out, data)
	n, ok := unpad(out[len(out)-bs:])
	if !ok {
		return nil, errBadDecrypt
	}
	return out[:len(out)-n], nil
}

// evpBytesToKey is OpenSSL's legacy PEM key derivation: MD5, one
// iteration, the first 8 bytes of the IV as salt
func evpBytesToKey(passphrase, salt []byte, keyLen int) []byte {
	var key, prev []byte
	for len(key) < keyLen {
		h := md5.New()
		h.Write(prev)
		h.Write(passphrase)
		h.Write(salt[:8])
		prev = h.Sum(nil)
		key = append(key, prev...)
	}
	return key[:keyLen]
}

func decryptLegacyPEM(b *pem.Block, passphrase []byte) ([]byte, error) {
	name, ivHex, ok := strings.Cut(b.Headers["DEK-Info"], ",")
	c := keyCipherByName(strings.ToUpper(strings.TrimSpace(name)))
	if !ok || c == nil {
		return nil, errDecoderUnsupported
	}
	iv, err := hex.DecodeString(strings.TrimSpace(ivHex))
	if err != nil || len(iv) < 8 {
		return nil, errDecoderUnsupported
	}
	return c.decrypt(evpBytesToKey(passphrase, iv, c.keyLen), iv, b.Bytes)
}

func encryptLegacyPEM(label string, der []byte, cipherName string, passphrase []byte) (string, error) {
	c := keyCiphers[cipherName]
	if c == nil {
		return "", errUnknownCipher
	}
	block, _ := c.newCiph(make([]byte, c.keyLen))
	iv := make([]byte, block.BlockSize())
	rand.Read(iv)

	encrypted := c.encrypt(evpBytesToKey(passphrase, iv, c.keyLen), iv, der)
	return encodePEM(label, map[string]string{
		"Proc-Type": "4,ENCRYPTED",
		"DEK-Info":  c.name + "," + strings.ToUpper(hex.EncodeToString(iv)),
	}, encrypted), nil
}

// --- encrypted PKCS#8 (PBES2) ---

var (
	oidPBES2  = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 5, 13}
	oidPBKDF2 = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 5, 12}
	oidScrypt = asn1.ObjectIdentifier{1, 3, 6, 1, 4, 1, 11591, 4, 11}
	// the hmacWithSHA* PRFs are digestAlgorithm.n
	oidDigestAlgorithms = asn1.ObjectIdentifier{1, 2, 840, 113549, 2}
	// hmacWithSHA1 (the default), SHA224, SHA256, SHA384, SHA512,
	// SHA512-224, SHA512-256
	prfDigests = map[int]string{7: "sha1", 8: "sha224", 9: "sha256", 10: "sha384", 11: "sha512", 12: "sha512-224", 13: "sha512-256"}
)

func isEncryptedPKCS8(der []byte) bool {
	input := cryptobyte.String(der)
	var seq cryptobyte.String
	return input.ReadASN1(&seq, cbasn1.SEQUENCE) && seq.PeekASN1Tag(cbasn1.SEQUENCE)
}

func decryptPKCS8(der []byte, passphrase []byte) ([]byte, error) {
	input := cryptobyte.String(der)
	var seq, encrypted, pbes2, kdfParams cryptobyte.String
	if !input.ReadASN1(&seq, cbasn1.SEQUENCE) {
		return nil, errDecoderUnsupported
	}
	oid, params, ok := readAlgorithm(&seq)
	if !ok || !seq.ReadASN1(&encrypted, cbasn1.OCTET_STRING) {
		return nil, errDecoderUnsupported
	}
	if !oid.Equal(oidPBES2) {
		// PBES1 and PKCS#12 schemes are legacy OpenSSL providers in Node too
		return nil, newError("ERR_OSSL_EVP_UNSUPPORTED", "error:0308010C:digital envelope routines::unsupported")
	}
	if !params.ReadASN1(&pbes2, cbasn1.SEQUENCE) {
		return nil, errDecoderUnsupported
	}
	kdfOid, kdfParamsSeq, ok := readAlgorithm(&pbes2)
	if !ok || !kdfParamsSeq.ReadASN1(&kdfParams, cbasn1.SEQUENCE) {
		return nil, errDecoderUnsupported
	}
	encOid, encParams, ok := readAlgorithm(&pbes2)
	if !ok {
		return nil, errDecoderUnsupported
	}

	c := keyCipherByOid(encOid)
	var iv cryptobyte.String
	if c == nil || !encParams.ReadASN1(&iv, cbasn1.OCTET_STRING) {
		return nil, newError("ERR_OSSL_EVP_UNSUPPORTED", "error:0308010C:digital envelope routines::unsupported")
	}

	var salt cryptobyte.String
	var key []byte
	switch {
	case kdfOid.Equal(oidPBKDF2):
		var iterations, keyLen int
		if !kdfParams.ReadASN1(&salt, cbasn1.OCTET_STRING) || !kdfParams.ReadASN1Integer(&iterations) || iterations < 1 {
			return nil, errDecoderUnsupported
		}
		keyLen = c.keyLen
		if kdfParams.PeekASN1Tag(cbasn1.INTEGER) && (!kdfParams.ReadASN1Integer(&keyLen) || keyLen != c.keyLen) {
			return nil, errDecoderUnsupported
		}
		prf := "sha1"
		if !kdfParams.Empty() {
			prfOid, _, ok := readAlgorithm(&kdfParams)
			if !ok || len(prfOid) != 6 || !prfOid[:5].Equal(oidDigestAlgorithms) || prfDigests[prfOid[5]] == "" {
				return nil, newError("ERR_OSSL_EVP_UNSUPPORTED", "error:0308010C:digital envelope routines::unsupported")
			}
			prf = prfDigests[prfOid[5]]
		}
		d := digests[prf]
		var err error
		key, err = pbkdf2.Key(func() hash.Hash { return d.new() }, string(passphrase), salt, iterations, keyLen)
		if err != nil {
			return nil, errBadDecrypt
		}
	case kdfOid.Equal(oidScrypt):
		var n, r, p int
		if !kdfParams.ReadASN1(&salt, cbasn1.OCTET_STRING) || !kdfParams.ReadASN1Integer(&n) ||
			!kdfParams.ReadASN1Integer(&r) || !kdfParams.ReadASN1Integer(&p) {
			return nil, errDecoderUnsupported
		}
		var err error
		key, err = scrypt.Key(passphrase, salt, n, r, p, c.keyLen)
		if err != nil {
			return nil, errDecoderUnsupported
		}
	default:
		return nil, newError("ERR_OSSL_EVP_UNSUPPORTED", "error:0308010C:digital envelope routines::unsupported")
	}

	return c.decrypt(key, iv, encrypted)
}

// encryptPKCS8 writes what OpenSSL 3 writes for Node: PBES2, PBKDF2 with
// hmacWithSHA256, 2048 iterations and a 16-byte salt
func encryptPKCS8(der []byte, cipherName string, passphrase []byte) ([]byte, error) {
	c := keyCiphers[cipherName]
	if c == nil {
		return nil, errUnknownCipher
	}
	const iterations = 2048
	salt := make([]byte, 16)
	rand.Read(salt)
	block, _ := c.newCiph(make([]byte, c.keyLen))
	iv := make([]byte, block.BlockSize())
	rand.Read(iv)

	key, err := pbkdf2.Key(digests["sha256"].new, string(passphrase), salt, iterations, c.keyLen)
	if err != nil {
		return nil, err
	}
	encrypted := c.encrypt(key, iv, der)

	var b cryptobyte.Builder
	b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
		b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
			b.AddASN1ObjectIdentifier(oidPBES2)
			b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
				b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
					b.AddASN1ObjectIdentifier(oidPBKDF2)
					b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
						b.AddASN1OctetString(salt)
						b.AddASN1Int64(iterations)
						b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
							b.AddASN1ObjectIdentifier(append(oidDigestAlgorithms[:5:5], 9))
							b.AddASN1NULL()
						})
					})
				})
				b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
					b.AddASN1ObjectIdentifier(c.oid)
					b.AddASN1OctetString(iv)
				})
			})
		})
		b.AddASN1OctetString(encrypted)
	})
	return b.Bytes()
}
