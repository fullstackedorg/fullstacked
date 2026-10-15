package crypto

import (
	"crypto/ecdh"
	"crypto/ed25519"
	"crypto/rsa"
	"crypto/x509"
	"encoding/asn1"
	"encoding/base64"
	"encoding/json"
	"fullstackedorg/fullstacked/types"
	"strconv"
	"sync"

	"github.com/cloudflare/circl/dh/x448"
	"github.com/cloudflare/circl/sign/ed448"
	"golang.org/x/crypto/cryptobyte"
	cbasn1 "golang.org/x/crypto/cryptobyte/asn1"
)

var (
	oidRSA        = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 1}
	oidRSAPSS     = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 10}
	oidMGF1       = asn1.ObjectIdentifier{1, 2, 840, 113549, 1, 1, 8}
	oidECPublic   = asn1.ObjectIdentifier{1, 2, 840, 10045, 2, 1}
	oidX25519     = asn1.ObjectIdentifier{1, 3, 101, 110}
	oidX448       = asn1.ObjectIdentifier{1, 3, 101, 111}
	oidEd25519    = asn1.ObjectIdentifier{1, 3, 101, 112}
	oidEd448      = asn1.ObjectIdentifier{1, 3, 101, 113}
	okpOids       = map[string]asn1.ObjectIdentifier{"x25519": oidX25519, "x448": oidX448, "ed25519": oidEd25519, "ed448": oidEd448}
	okpPublicSize = map[string]int{"x25519": 32, "x448": 56, "ed25519": 32, "ed448": 57}
)

// pssParams are the restrictions of an RSA-PSS key that has parameters
type pssParams struct {
	hash    *digest
	mgf1    *digest
	saltLen int
}

// asymKey is a parsed key. Every format comes in and goes out through it;
// the JS KeyObject only keeps its DER (SPKI or PKCS#8).
type asymKey struct {
	kind    string // Node's asymmetricKeyType
	private bool

	rsa    *rsa.PrivateKey
	rsaPub *rsa.PublicKey
	pss    *pssParams // rsa-pss with parameters

	curve  *ecCurve
	scalar []byte // curve size
	point  []byte // uncompressed

	seed []byte // okp private
	pub  []byte // okp public

	// built once from the seed: the key cache keeps them, so a repeated
	// sign or X25519 does not redo the scalar multiplication that derives
	// the public key
	ed25519Key ed25519.PrivateKey
	x25519Key  *ecdh.PrivateKey
}

func (k *asymKey) public() *asymKey {
	if !k.private {
		return k
	}
	p := *k
	p.private, p.rsa, p.scalar, p.seed = false, nil, nil, nil
	p.ed25519Key, p.x25519Key = nil, nil
	return &p
}

func (k *asymKey) isRSA() bool {
	return k.kind == "rsa" || k.kind == "rsa-pss"
}

type keyDetails struct {
	ModulusLength     int    `json:"modulusLength,omitempty"`
	PublicExponent    string `json:"publicExponent,omitempty"`
	HashAlgorithm     string `json:"hashAlgorithm,omitempty"`
	Mgf1HashAlgorithm string `json:"mgf1HashAlgorithm,omitempty"`
	SaltLength        *int   `json:"saltLength,omitempty"`
	NamedCurve        string `json:"namedCurve,omitempty"`
}

// details are Node's asymmetricKeyDetails, the exponent as a decimal
// string (a BigInt on the JS side)
func (k *asymKey) details() keyDetails {
	d := keyDetails{}
	switch {
	case k.isRSA():
		d.ModulusLength = k.rsaPub.N.BitLen()
		d.PublicExponent = strconv.Itoa(k.rsaPub.E)
		if k.pss != nil {
			d.HashAlgorithm = k.pss.hash.name
			d.Mgf1HashAlgorithm = k.pss.mgf1.name
			salt := k.pss.saltLen
			d.SaltLength = &salt
		}
	case k.kind == "ec":
		d.NamedCurve = k.curve.name
	}
	return d
}

// --- parsing ---

func readAlgorithm(input *cryptobyte.String) (asn1.ObjectIdentifier, cryptobyte.String, bool) {
	var alg cryptobyte.String
	var oid asn1.ObjectIdentifier
	if !input.ReadASN1(&alg, cbasn1.SEQUENCE) || !alg.ReadASN1ObjectIdentifier(&oid) {
		return nil, nil, false
	}
	return oid, alg, true
}

func okpKind(oid asn1.ObjectIdentifier) string {
	for kind, o := range okpOids {
		if o.Equal(oid) {
			return kind
		}
	}
	return ""
}

// rsaKind reads the algorithm of an RSA key, and the PSS parameters
func rsaKind(oid asn1.ObjectIdentifier, params cryptobyte.String) (string, *pssParams, bool) {
	if oid.Equal(oidRSA) {
		return "rsa", nil, true
	}
	if !oid.Equal(oidRSAPSS) {
		return "", nil, false
	}
	if params.Empty() || params.PeekASN1Tag(cbasn1.NULL) {
		return "rsa-pss", nil, true
	}
	pss, ok := parsePSSParams(params)
	return "rsa-pss", pss, ok
}

func parsePSSParams(params cryptobyte.String) (*pssParams, bool) {
	var seq cryptobyte.String
	if !params.ReadASN1(&seq, cbasn1.SEQUENCE) {
		return nil, false
	}
	p := &pssParams{hash: digests["sha1"], mgf1: digests["sha1"], saltLen: 20}

	hashAlg := func(s *cryptobyte.String) *digest {
		oid, _, ok := readAlgorithm(s)
		if !ok {
			return nil
		}
		return digestByOid(oid)
	}

	var field cryptobyte.String
	var present bool
	if !seq.ReadOptionalASN1(&field, &present, cbasn1.Tag(0).Constructed().ContextSpecific()) {
		return nil, false
	}
	if present {
		if p.hash = hashAlg(&field); p.hash == nil {
			return nil, false
		}
	}
	if !seq.ReadOptionalASN1(&field, &present, cbasn1.Tag(1).Constructed().ContextSpecific()) {
		return nil, false
	}
	if present {
		oid, mgfParams, ok := readAlgorithm(&field)
		if !ok || !oid.Equal(oidMGF1) {
			return nil, false
		}
		if p.mgf1 = hashAlg(&mgfParams); p.mgf1 == nil {
			return nil, false
		}
	}
	if !seq.ReadOptionalASN1(&field, &present, cbasn1.Tag(2).Constructed().ContextSpecific()) {
		return nil, false
	}
	if present && (!field.ReadASN1Integer(&p.saltLen) || p.saltLen < 0) {
		return nil, false
	}
	return p, true
}

func parseSPKI(der []byte) (*asymKey, error) {
	input := cryptobyte.String(der)
	var spki cryptobyte.String
	var bits asn1.BitString
	if !input.ReadASN1(&spki, cbasn1.SEQUENCE) || !input.Empty() {
		return nil, errDecoderUnsupported
	}
	oid, params, ok := readAlgorithm(&spki)
	if !ok || !spki.ReadASN1BitString(&bits) || bits.BitLength%8 != 0 {
		return nil, errDecoderUnsupported
	}
	pub := bits.Bytes

	if kind, pss, ok := rsaKind(oid, params); kind != "" {
		if !ok {
			return nil, errDecoderUnsupported
		}
		key, err := x509.ParsePKCS1PublicKey(pub)
		if err != nil {
			return nil, errDecoderUnsupported
		}
		return &asymKey{kind: kind, rsaPub: key, pss: pss}, nil
	}

	if oid.Equal(oidECPublic) {
		var curveOid asn1.ObjectIdentifier
		if !params.ReadASN1ObjectIdentifier(&curveOid) {
			return nil, errDecoderUnsupported
		}
		curve := curveByOid(curveOid)
		if curve == nil {
			return nil, errDecoderUnsupported
		}
		point, ok := curve.decodePoint(pub)
		if !ok {
			return nil, errDecoderUnsupported
		}
		return &asymKey{kind: "ec", curve: curve, point: clone(point)}, nil
	}

	if kind := okpKind(oid); kind != "" {
		if len(pub) != okpPublicSize[kind] {
			return nil, errDecoderUnsupported
		}
		return &asymKey{kind: kind, pub: clone(pub)}, nil
	}

	return nil, errDecoderUnsupported
}

func parsePKCS8(der []byte) (*asymKey, error) {
	input := cryptobyte.String(der)
	var pkcs8, privateKey cryptobyte.String
	var version int
	if !input.ReadASN1(&pkcs8, cbasn1.SEQUENCE) || !input.Empty() ||
		!pkcs8.ReadASN1Integer(&version) || version > 1 {
		return nil, errDecoderUnsupported
	}
	oid, params, ok := readAlgorithm(&pkcs8)
	if !ok || !pkcs8.ReadASN1(&privateKey, cbasn1.OCTET_STRING) {
		return nil, errDecoderUnsupported
	}

	if kind, pss, ok := rsaKind(oid, params); kind != "" {
		if !ok {
			return nil, errDecoderUnsupported
		}
		key, err := parsePKCS1Private(privateKey)
		if err != nil {
			return nil, err
		}
		key.kind, key.pss = kind, pss
		return key, nil
	}

	if oid.Equal(oidECPublic) {
		var curve *ecCurve
		var curveOid asn1.ObjectIdentifier
		if params.ReadASN1ObjectIdentifier(&curveOid) {
			if curve = curveByOid(curveOid); curve == nil {
				return nil, errDecoderUnsupported
			}
		}
		return parseSEC1(privateKey, curve)
	}

	if kind := okpKind(oid); kind != "" {
		var seed cryptobyte.String
		if !privateKey.ReadASN1(&seed, cbasn1.OCTET_STRING) {
			return nil, errDecoderUnsupported
		}
		return okpPrivate(kind, seed)
	}

	return nil, errDecoderUnsupported
}

func parsePKCS1Private(der []byte) (*asymKey, error) {
	key, err := x509.ParsePKCS1PrivateKey(der)
	if err != nil {
		return nil, errDecoderUnsupported
	}
	return &asymKey{kind: "rsa", private: true, rsa: key, rsaPub: &key.PublicKey}, nil
}

// parseSEC1 reads an ECPrivateKey, curve comes from the PKCS#8 algorithm
// when wrapped, from the key's own parameters otherwise
func parseSEC1(der []byte, curve *ecCurve) (*asymKey, error) {
	input := cryptobyte.String(der)
	var seq, priv cryptobyte.String
	var version int
	if !input.ReadASN1(&seq, cbasn1.SEQUENCE) || !seq.ReadASN1Integer(&version) || version != 1 ||
		!seq.ReadASN1(&priv, cbasn1.OCTET_STRING) {
		return nil, errDecoderUnsupported
	}

	var params cryptobyte.String
	var present bool
	if !seq.ReadOptionalASN1(&params, &present, cbasn1.Tag(0).Constructed().ContextSpecific()) {
		return nil, errDecoderUnsupported
	}
	if present {
		var oid asn1.ObjectIdentifier
		if !params.ReadASN1ObjectIdentifier(&oid) {
			return nil, errDecoderUnsupported
		}
		paramCurve := curveByOid(oid)
		if paramCurve == nil || (curve != nil && curve != paramCurve) {
			return nil, errDecoderUnsupported
		}
		curve = paramCurve
	}
	if curve == nil {
		return nil, errDecoderUnsupported
	}

	return ecPrivate(curve, priv)
}

func ecPrivate(curve *ecCurve, scalar []byte) (*asymKey, error) {
	scalar, ok := curve.scalar(scalar)
	if !ok {
		return nil, errDecoderUnsupported
	}
	point, err := curve.publicKey(scalar)
	if err != nil {
		return nil, errDecoderUnsupported
	}
	return &asymKey{kind: "ec", private: true, curve: curve, scalar: scalar, point: point}, nil
}

func okpPrivate(kind string, seed []byte) (*asymKey, error) {
	k := &asymKey{kind: kind, private: true, seed: clone(seed)}
	switch kind {
	case "ed25519":
		if len(seed) != ed25519.SeedSize {
			return nil, errDecoderUnsupported
		}
		k.ed25519Key = ed25519.NewKeyFromSeed(seed)
		k.pub = k.ed25519Key.Public().(ed25519.PublicKey)
	case "ed448":
		if len(seed) != ed448.SeedSize {
			return nil, errDecoderUnsupported
		}
		k.pub = ed448.NewKeyFromSeed(seed).Public().(ed448.PublicKey)
	case "x25519":
		priv, err := ecdh.X25519().NewPrivateKey(seed)
		if err != nil {
			return nil, errDecoderUnsupported
		}
		k.x25519Key = priv
		k.pub = priv.PublicKey().Bytes()
	case "x448":
		if len(seed) != x448.Size {
			return nil, errDecoderUnsupported
		}
		var secret, public x448.Key
		copy(secret[:], seed)
		x448.KeyGen(&public, &secret)
		k.pub = public[:]
	}
	return k, nil
}

// parseDER reads a key of the given DER type. wantPublic accepts a private
// key too, the caller derives the public one (Node's createPublicKey).
func parseDER(der []byte, typ string, wantPublic bool) (*asymKey, error) {
	switch typ {
	case "spki":
		if !wantPublic {
			return nil, errDecoderUnsupported
		}
		return parseSPKI(der)
	case "pkcs8":
		return parsePKCS8(der)
	case "sec1":
		return parseSEC1(der, nil)
	case "pkcs1":
		if wantPublic && !looksLikeRSAPrivate(der) {
			key, err := x509.ParsePKCS1PublicKey(der)
			if err != nil {
				return nil, errDecoderUnsupported
			}
			return &asymKey{kind: "rsa", rsaPub: key}, nil
		}
		return parsePKCS1Private(der)
	}
	return nil, errDecoderUnsupported
}

// looksLikeRSAPrivate tells an RSAPrivateKey (version 0 first) from an
// RSAPublicKey (modulus first)
func looksLikeRSAPrivate(der []byte) bool {
	input := cryptobyte.String(der)
	var seq cryptobyte.String
	var version int64
	return input.ReadASN1(&seq, cbasn1.SEQUENCE) && seq.ReadASN1Integer(&version) && version <= 1 && !seq.Empty()
}

// parseKeyDER reads the DER a KeyObject keeps: SPKI or PKCS#8
func parseKeyDER(der []byte) (*asymKey, error) {
	input := cryptobyte.String(der)
	var seq cryptobyte.String
	if !input.ReadASN1(&seq, cbasn1.SEQUENCE) {
		return nil, errDecoderUnsupported
	}
	if seq.PeekASN1Tag(cbasn1.INTEGER) {
		return parsePKCS8(der)
	}
	return parseSPKI(der)
}

// keys used for sign, verify, ECDH and RSA come as DER on every call,
// they are parsed once
const keyCacheSize = 64

var keyCache = struct {
	sync.Mutex
	keys  map[string]*asymKey
	order []string
}{keys: map[string]*asymKey{}}

func loadKey(der []byte) (*asymKey, error) {
	keyCache.Lock()
	k, ok := keyCache.keys[string(der)]
	keyCache.Unlock()
	if ok {
		return k, nil
	}

	k, err := parseKeyDER(der)
	if err != nil {
		return nil, err
	}

	keyCache.Lock()
	defer keyCache.Unlock()
	if _, ok := keyCache.keys[string(der)]; !ok {
		if len(keyCache.order) >= keyCacheSize {
			delete(keyCache.keys, keyCache.order[0])
			keyCache.order = keyCache.order[1:]
		}
		keyCache.keys[string(der)] = k
		keyCache.order = append(keyCache.order, string(der))
	}
	return k, nil
}

// --- encoding ---

func addAlgorithm(b *cryptobyte.Builder, k *asymKey) {
	b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
		switch k.kind {
		case "rsa":
			b.AddASN1ObjectIdentifier(oidRSA)
			b.AddASN1NULL()
		case "rsa-pss":
			b.AddASN1ObjectIdentifier(oidRSAPSS)
			if k.pss != nil {
				addPSSParams(b, k.pss)
			}
		case "ec":
			b.AddASN1ObjectIdentifier(oidECPublic)
			b.AddASN1ObjectIdentifier(k.curve.oid)
		default:
			b.AddASN1ObjectIdentifier(okpOids[k.kind])
		}
	})
}

// addPSSParams writes the fields that differ from the defaults (sha1,
// mgf1 sha1, salt 20), as OpenSSL does
func addPSSParams(b *cryptobyte.Builder, p *pssParams) {
	hashAlg := func(b *cryptobyte.Builder, d *digest) {
		b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
			b.AddASN1ObjectIdentifier(d.oid)
			b.AddASN1NULL()
		})
	}
	b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
		if p.hash.name != "sha1" {
			b.AddASN1(cbasn1.Tag(0).Constructed().ContextSpecific(), func(b *cryptobyte.Builder) {
				hashAlg(b, p.hash)
			})
		}
		if p.mgf1.name != "sha1" {
			b.AddASN1(cbasn1.Tag(1).Constructed().ContextSpecific(), func(b *cryptobyte.Builder) {
				b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
					b.AddASN1ObjectIdentifier(oidMGF1)
					hashAlg(b, p.mgf1)
				})
			})
		}
		if p.saltLen != 20 {
			b.AddASN1(cbasn1.Tag(2).Constructed().ContextSpecific(), func(b *cryptobyte.Builder) {
				b.AddASN1Int64(int64(p.saltLen))
			})
		}
	})
}

func (k *asymKey) publicBytes() []byte {
	switch {
	case k.isRSA():
		return x509.MarshalPKCS1PublicKey(k.rsaPub)
	case k.kind == "ec":
		return k.point
	}
	return k.pub
}

func (k *asymKey) spki() []byte {
	var b cryptobyte.Builder
	b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
		addAlgorithm(b, k)
		b.AddASN1BitString(k.publicBytes())
	})
	return b.BytesOrPanic()
}

func (k *asymKey) sec1(withCurve bool) []byte {
	var b cryptobyte.Builder
	b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
		b.AddASN1Int64(1)
		b.AddASN1OctetString(k.scalar)
		if withCurve {
			b.AddASN1(cbasn1.Tag(0).Constructed().ContextSpecific(), func(b *cryptobyte.Builder) {
				b.AddASN1ObjectIdentifier(k.curve.oid)
			})
		}
		b.AddASN1(cbasn1.Tag(1).Constructed().ContextSpecific(), func(b *cryptobyte.Builder) {
			b.AddASN1BitString(k.point)
		})
	})
	return b.BytesOrPanic()
}

func (k *asymKey) pkcs8() []byte {
	var inner []byte
	switch {
	case k.isRSA():
		inner = x509.MarshalPKCS1PrivateKey(k.rsa)
	case k.kind == "ec":
		// OpenSSL leaves the curve out of the inner key, it is in the
		// algorithm already
		inner = k.sec1(false)
	default:
		var b cryptobyte.Builder
		b.AddASN1OctetString(k.seed)
		inner = b.BytesOrPanic()
	}

	var b cryptobyte.Builder
	b.AddASN1(cbasn1.SEQUENCE, func(b *cryptobyte.Builder) {
		b.AddASN1Int64(0)
		addAlgorithm(b, k)
		b.AddASN1OctetString(inner)
	})
	return b.BytesOrPanic()
}

// der is the form the JS KeyObject keeps
func (k *asymKey) der() []byte {
	if k.private {
		return k.pkcs8()
	}
	return k.spki()
}

func (k *asymKey) describe() map[string]any {
	typ := "public"
	if k.private {
		typ = "private"
	}
	return map[string]any{
		"type":              typ,
		"asymmetricKeyType": k.kind,
		"details":           k.details(),
		"der":               base64.StdEncoding.EncodeToString(k.der()),
	}
}

// keyParse: key (string or buffer), format (pem, der, jwk), type?,
// passphrase?, wantPublic -> { type, asymmetricKeyType, details, der }
func keyParse(_ *types.Context, a args) (any, error) {
	wantPublic := a.bool(4)
	var passphrase []byte
	if a.defined(3) {
		passphrase = a.buf(3)
		if passphrase == nil {
			passphrase = []byte{}
		}
	}

	var k *asymKey
	var err error
	switch a.str(1) {
	case "pem":
		k, err = parsePEM(a.buf(0), wantPublic, passphrase)
	case "der":
		der := a.buf(0)
		if a.str(2) == "pkcs8" && isEncryptedPKCS8(der) {
			if passphrase == nil {
				return nil, errDerNoPassphrase
			}
			if der, err = decryptPKCS8(der, passphrase); err != nil {
				return nil, err
			}
		}
		k, err = parseDER(der, a.str(2), wantPublic)
	case "jwk":
		var jwk map[string]any
		if err := a.object(0, &jwk); err != nil || jwk == nil {
			return nil, newTypeError("ERR_INVALID_ARG_TYPE", "The \"key.key\" property must be of type object.")
		}
		k, err = parseJWK(jwk, wantPublic)
	default:
		return nil, newTypeError("ERR_INVALID_ARG_VALUE", "The property 'key.format' is invalid. Received '"+a.str(1)+"'")
	}
	if err != nil {
		return nil, err
	}

	if wantPublic {
		k = k.public()
	}
	return k.describe(), nil
}

// keyExport: der, kind (public, private), format (pem, der, jwk), type?,
// cipher?, passphrase? -> string (pem), buffer (der) or object (jwk)
func keyExport(_ *types.Context, a args) (any, error) {
	k, err := loadKey(a.buf(0))
	if err != nil {
		return nil, err
	}
	if a.str(1) == "public" {
		k = k.public()
	}

	format, typ := a.str(2), a.str(3)
	if format == "jwk" {
		return exportJWK(k)
	}

	invalidType := newTypeError("ERR_INVALID_ARG_VALUE", "The property 'options.type' is invalid. Received '"+typ+"'")

	var der []byte
	var label string
	switch typ {
	case "spki":
		if k.private {
			return nil, invalidType
		}
		der, label = k.spki(), "PUBLIC KEY"
	case "pkcs1":
		if k.kind != "rsa" {
			return nil, errIncompatibleKeyOptions("pkcs1", "RSA")
		}
		if k.private {
			der, label = x509.MarshalPKCS1PrivateKey(k.rsa), "RSA PRIVATE KEY"
		} else {
			der, label = x509.MarshalPKCS1PublicKey(k.rsaPub), "RSA PUBLIC KEY"
		}
	case "pkcs8":
		if !k.private {
			return nil, invalidType
		}
		der, label = k.pkcs8(), "PRIVATE KEY"
	case "sec1":
		if !k.private {
			return nil, invalidType
		}
		if k.kind != "ec" {
			return nil, errIncompatibleKeyOptions("sec1", "EC")
		}
		der, label = k.sec1(true), "EC PRIVATE KEY"
	default:
		return nil, invalidType
	}

	if a.defined(4) && k.private {
		passphrase := a.buf(5)
		if typ == "pkcs8" {
			der, err = encryptPKCS8(der, a.str(4), passphrase)
			if err != nil {
				return nil, err
			}
			label = "ENCRYPTED PRIVATE KEY"
		} else {
			if format == "der" {
				return nil, errEncryptionNotSupported(typ)
			}
			return encryptLegacyPEM(label, der, a.str(4), passphrase)
		}
	}

	if format == "der" {
		return der, nil
	}
	return encodePEM(label, nil, der), nil
}

// jsonObject keeps the key order of Node's JWK output
type jsonObject [][2]string

func (o jsonObject) MarshalJSON() ([]byte, error) {
	out := []byte{'{'}
	for i, kv := range o {
		if i > 0 {
			out = append(out, ',')
		}
		k, _ := json.Marshal(kv[0])
		v, _ := json.Marshal(kv[1])
		out = append(append(append(out, k...), ':'), v...)
	}
	return append(out, '}'), nil
}
