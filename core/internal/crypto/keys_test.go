package crypto

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/json"
	"encoding/pem"
	"math/big"
	"strings"
	"testing"
	"time"
)

type parsedKey struct {
	Type              string         `json:"type"`
	AsymmetricKeyType string         `json:"asymmetricKeyType"`
	Details           map[string]any `json:"details"`
	Der               string         `json:"der"`
}

func parseKey(t *testing.T, values ...any) parsedKey {
	t.Helper()
	out := mustCall(t, newTestContext(), KeyParse, values...)
	raw, _ := json.Marshal(out)
	var k parsedKey
	json.Unmarshal(raw, &k)
	return k
}

func pemDER(s string) []byte {
	b, _ := pem.Decode([]byte(s))
	return b.Bytes
}

func jsonString(v any) string {
	b, _ := json.Marshal(v)
	return string(b)
}

func TestRSAKeys(t *testing.T) {
	ctx := newTestContext()
	priv := parseKey(t, nodeVectors["rsa.pkcs1"], "pem", nil, nil, false)
	if priv.Type != "private" || priv.AsymmetricKeyType != "rsa" || jsonString(priv.Details) != `{"modulusLength":1024,"publicExponent":"65537"}` {
		t.Fatalf("parsed %+v", priv)
	}
	der := unb64(priv.Der)
	if string(der) != string(pemDER(nodeVectors["rsa.pkcs8"])) {
		t.Fatal("pkcs8 der differs from node's")
	}

	// every input form gives the same key
	for _, c := range [][]any{
		{nodeVectors["rsa.pkcs8"], "pem", nil, nil, false},
		{[]byte(nodeVectors["rsa.pkcs8"]), "pem", nil, nil, false},
		{pemDER(nodeVectors["rsa.pkcs1"]), "der", "pkcs1", nil, false},
		{der, "der", "pkcs8", nil, false},
		{nodeVectors["rsa.pkcs8.aes256"], "pem", nil, []byte("secret"), false},
		{unhex(nodeVectors["rsa.pkcs8.des3"]), "der", "pkcs8", []byte("secret"), false},
		{nodeVectors["rsa.pkcs1.aes128"], "pem", nil, []byte("secret"), false},
		{nodeVectors["rsa.jwk"], "jwk", nil, nil, false},
	} {
		if got := parseKey(t, c...); got.Der != priv.Der {
			t.Fatalf("%v %v: different key", c[1], c[2])
		}
	}

	pub := parseKey(t, nodeVectors["rsa.spki"], "pem", nil, nil, true)
	if pub.Type != "public" || string(unb64(pub.Der)) != string(pemDER(nodeVectors["rsa.spki"])) {
		t.Fatalf("public %+v", pub)
	}
	for _, c := range [][]any{
		{nodeVectors["rsa.pkcs1"], "pem", nil, nil, true},
		{nodeVectors["rsa.pkcs1pub"], "pem", nil, nil, true},
		{pemDER(nodeVectors["rsa.pkcs1pub"]), "der", "pkcs1", nil, true},
		{pemDER(nodeVectors["rsa.pkcs1"]), "der", "pkcs1", nil, true},
		{der, "der", "pkcs8", nil, true},
		{nodeVectors["rsa.jwk"], "jwk", nil, nil, true},
	} {
		if got := parseKey(t, c...); got.Der != pub.Der {
			t.Fatalf("public %v %v: different key", c[1], c[2])
		}
	}

	// exports match Node's
	if got := mustCall(t, ctx, KeyExport, der, "private", "pem", "pkcs1"); got != nodeVectors["rsa.pkcs1"] {
		t.Fatalf("pkcs1 export %v", got)
	}
	if got := mustCall(t, ctx, KeyExport, der, "public", "pem", "spki"); got != nodeVectors["rsa.spki"] {
		t.Fatalf("spki export %v", got)
	}
	if got := mustCall(t, ctx, KeyExport, unb64(pub.Der), "public", "pem", "pkcs1"); got != nodeVectors["rsa.pkcs1pub"] {
		t.Fatalf("pkcs1 public export %v", got)
	}
	if got := jsonString(mustCall(t, ctx, KeyExport, der, "private", "jwk")); got != nodeVectors["rsa.jwk"] {
		t.Fatalf("jwk export %v", got)
	}

	// encrypted exports read back
	encrypted := mustCall(t, ctx, KeyExport, der, "private", "pem", "pkcs8", "aes-128-cbc", []byte("pass")).(string)
	if !strings.HasPrefix(encrypted, "-----BEGIN ENCRYPTED PRIVATE KEY-----") || parseKey(t, encrypted, "pem", nil, []byte("pass"), false).Der != priv.Der {
		t.Fatal("encrypted pkcs8 round trip")
	}
	encryptedDer := mustBytes(t, ctx, KeyExport, der, "private", "der", "pkcs8", "des-ede3-cbc", []byte("pass"))
	if parseKey(t, encryptedDer, "der", "pkcs8", []byte("pass"), false).Der != priv.Der {
		t.Fatal("encrypted pkcs8 der round trip")
	}
	legacy := mustCall(t, ctx, KeyExport, der, "private", "pem", "pkcs1", "aes-256-cbc", []byte("pass")).(string)
	if !strings.Contains(legacy, "DEK-Info: AES-256-CBC,") || parseKey(t, legacy, "pem", nil, []byte("pass"), false).Der != priv.Der {
		t.Fatal("legacy pem round trip")
	}

	// Node's errors
	_, err := call(ctx, KeyParse, nodeVectors["rsa.pkcs8.aes256"], "pem", nil, nil, false)
	expectError(t, err, "Error|ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED")
	_, err = call(ctx, KeyParse, nodeVectors["rsa.pkcs1.aes128"], "pem", nil, nil, true)
	expectError(t, err, "Error|ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED")
	_, err = call(ctx, KeyParse, nodeVectors["rsa.pkcs8.aes256"], "pem", nil, []byte("wrong"), false)
	expectError(t, err, "Error|ERR_OSSL_BAD_DECRYPT")
	_, err = call(ctx, KeyParse, nodeVectors["rsa.pkcs1.aes128"], "pem", nil, []byte("wrong"), false)
	expectError(t, err, "Error|ERR_OSSL_BAD_DECRYPT")
	_, err = call(ctx, KeyParse, unhex(nodeVectors["rsa.pkcs8.des3"]), "der", "pkcs8", nil, false)
	expectError(t, err, "TypeError|ERR_MISSING_PASSPHRASE")
	_, err = call(ctx, KeyParse, nodeVectors["rsa.spki"], "pem", nil, nil, false)
	expectError(t, err, "Error|ERR_OSSL_UNSUPPORTED")
	_, err = call(ctx, KeyParse, "hello", "pem", nil, nil, true)
	expectError(t, err, "Error|ERR_OSSL_UNSUPPORTED")
	_, err = call(ctx, KeyExport, der, "private", "der", "pkcs1", "aes-128-cbc", []byte("pass"))
	expectError(t, err, "Error|ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS")
	_, err = call(ctx, KeyExport, der, "private", "pem", "sec1")
	expectError(t, err, "Error|ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS")
	_, err = call(ctx, KeyExport, der, "private", "pem", "spki")
	expectError(t, err, "TypeError|ERR_INVALID_ARG_VALUE")
	_, err = call(ctx, KeyExport, der, "public", "pem", "pkcs8")
	expectError(t, err, "TypeError|ERR_INVALID_ARG_VALUE")

	var jwk map[string]any
	json.Unmarshal([]byte(nodeVectors["rsa.jwk"]), &jwk)
	delete(jwk, "qi")
	_, err = call(ctx, KeyParse, jwk, "jwk", nil, nil, false)
	expectError(t, err, "TypeError|ERR_INVALID_ARG_TYPE")
	jwk["kty"] = "foo"
	_, err = call(ctx, KeyParse, jwk, "jwk", nil, nil, true)
	expectError(t, err, "TypeError|ERR_INVALID_ARG_VALUE")
}

func TestRSAPSSKeys(t *testing.T) {
	ctx := newTestContext()
	priv := parseKey(t, nodeVectors["pss.pkcs8"], "pem", nil, nil, false)
	if priv.AsymmetricKeyType != "rsa-pss" ||
		jsonString(priv.Details) != `{"hashAlgorithm":"sha256","mgf1HashAlgorithm":"sha1","modulusLength":1024,"publicExponent":"65537","saltLength":24}` {
		t.Fatalf("parsed %+v", priv)
	}
	// the parameters are written back as OpenSSL writes them
	if string(unb64(priv.Der)) != string(pemDER(nodeVectors["pss.pkcs8"])) {
		t.Fatal("pkcs8 der differs from node's")
	}
	if got := mustCall(t, ctx, KeyExport, unb64(priv.Der), "public", "pem", "spki"); got != nodeVectors["pss.spki"] {
		t.Fatalf("spki %v", got)
	}

	unrestricted := parseKey(t, nodeVectors["pssu.pkcs8"], "pem", nil, nil, false)
	if jsonString(unrestricted.Details) != `{"modulusLength":1024,"publicExponent":"65537"}` ||
		string(unb64(unrestricted.Der)) != string(pemDER(nodeVectors["pssu.pkcs8"])) {
		t.Fatalf("unrestricted %+v", unrestricted)
	}

	_, err := call(ctx, KeyExport, unb64(priv.Der), "private", "jwk")
	expectError(t, err, "Error|ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE")
	_, err = call(ctx, KeyExport, unb64(priv.Der), "private", "pem", "pkcs1")
	expectError(t, err, "Error|ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS")
}

func TestECKeys(t *testing.T) {
	ctx := newTestContext()
	for _, curve := range curves {
		name := curve.name
		priv := parseKey(t, nodeVectors["ec."+name+".sec1"], "pem", nil, nil, false)
		if priv.AsymmetricKeyType != "ec" || jsonString(priv.Details) != `{"namedCurve":"`+name+`"}` {
			t.Fatalf("%s: %+v", name, priv)
		}
		der := unb64(priv.Der)
		expectHex(t, name+" pkcs8", der, nodeVectors["ec."+name+".pkcs8"])
		pub := parseKey(t, nodeVectors["ec."+name+".sec1"], "pem", nil, nil, true)
		expectHex(t, name+" spki", unb64(pub.Der), nodeVectors["ec."+name+".spki"])

		if got := mustCall(t, ctx, KeyExport, der, "private", "pem", "sec1"); got != nodeVectors["ec."+name+".sec1"] {
			t.Fatalf("%s sec1 export %v", name, got)
		}
		sec1 := mustBytes(t, ctx, KeyExport, der, "private", "der", "sec1")
		if parseKey(t, sec1, "der", "sec1", nil, false).Der != priv.Der {
			t.Fatalf("%s sec1 der round trip", name)
		}
		legacy := mustCall(t, ctx, KeyExport, der, "private", "pem", "sec1", "aes-128-cbc", []byte("pass")).(string)
		if parseKey(t, legacy, "pem", nil, []byte("pass"), false).Der != priv.Der {
			t.Fatalf("%s legacy round trip", name)
		}

		if curve.jwk == "" {
			_, err := call(ctx, KeyExport, der, "private", "jwk")
			expectError(t, err, "Error|ERR_CRYPTO_JWK_UNSUPPORTED_CURVE")
			continue
		}
		jwk := nodeVectors["ec."+name+".jwk"]
		if got := jsonString(mustCall(t, ctx, KeyExport, der, "private", "jwk")); got != jwk {
			t.Fatalf("%s jwk %s", name, got)
		}
		if parseKey(t, jwk, "jwk", nil, nil, false).Der != priv.Der || parseKey(t, jwk, "jwk", nil, nil, true).Der != pub.Der {
			t.Fatalf("%s jwk import", name)
		}
	}

	var jwk map[string]any
	json.Unmarshal([]byte(nodeVectors["ec.prime256v1.jwk"]), &jwk)
	jwk["y"] = jwk["x"]
	_, err := call(ctx, KeyParse, jwk, "jwk", nil, nil, true)
	expectError(t, err, "TypeError|ERR_CRYPTO_INVALID_JWK")
	jwk["crv"] = "P-999"
	_, err = call(ctx, KeyParse, jwk, "jwk", nil, nil, true)
	expectError(t, err, "TypeError|ERR_INVALID_ARG_VALUE")
}

func TestOKPKeys(t *testing.T) {
	ctx := newTestContext()
	priv := parseKey(t, unhex(nodeVectors["ed448.pkcs8"]), "der", "pkcs8", nil, false)
	if priv.AsymmetricKeyType != "ed448" || jsonString(priv.Details) != "{}" {
		t.Fatalf("ed448 %+v", priv)
	}
	if got := jsonString(mustCall(t, ctx, KeyExport, unb64(priv.Der), "private", "jwk")); got != nodeVectors["ed448.jwk"] {
		t.Fatalf("ed448 jwk %s", got)
	}
	if parseKey(t, nodeVectors["ed448.jwk"], "jwk", nil, nil, false).Der != priv.Der {
		t.Fatal("ed448 jwk import")
	}

	for _, kind := range []string{"ed25519", "ed448", "x25519", "x448"} {
		pair := mustCall(t, ctx, KeyGenerate, kind, map[string]any{}).(map[string]string)
		der := unb64(pair["privateKey"])
		k := parseKey(t, der, "der", "pkcs8", nil, false)
		if k.AsymmetricKeyType != kind || parseKey(t, der, "der", "pkcs8", nil, true).Der != pair["publicKey"] {
			t.Fatalf("%s generated %+v", kind, k)
		}
		jwk := mustCall(t, ctx, KeyExport, der, "private", "jwk")
		if parseKey(t, jsonString(jwk), "jwk", nil, nil, false).Der != k.Der {
			t.Fatalf("%s jwk round trip", kind)
		}
		pem := mustCall(t, ctx, KeyExport, der, "private", "pem", "pkcs8").(string)
		if parseKey(t, pem, "pem", nil, nil, false).Der != k.Der {
			t.Fatalf("%s pem round trip", kind)
		}
	}

	_, err := call(ctx, KeyParse, map[string]any{"kty": "OKP", "crv": "Ed25519", "x": "AA"}, "jwk", nil, nil, true)
	expectError(t, err, "TypeError|ERR_CRYPTO_INVALID_JWK")
	_, err = call(ctx, KeyParse, map[string]any{"kty": "OKP", "crv": "foo", "x": "AA"}, "jwk", nil, nil, true)
	expectError(t, err, "TypeError|ERR_INVALID_ARG_VALUE")
}

func TestKeyGenerate(t *testing.T) {
	ctx := newTestContext()
	for _, c := range []struct {
		typ     string
		options map[string]any
		details string
	}{
		{"rsa", map[string]any{"modulusLength": 512}, `{"modulusLength":512,"publicExponent":"65537"}`},
		{"rsa", map[string]any{"modulusLength": 513, "publicExponent": 3}, `{"modulusLength":513,"publicExponent":"3"}`},
		{"rsa-pss", map[string]any{"modulusLength": 1024}, `{"modulusLength":1024,"publicExponent":"65537"}`},
		{"rsa-pss", map[string]any{"modulusLength": 1024, "hashAlgorithm": "sha256"}, `{"hashAlgorithm":"sha256","mgf1HashAlgorithm":"sha256","modulusLength":1024,"publicExponent":"65537","saltLength":32}`},
		{"rsa-pss", map[string]any{"modulusLength": 1024, "mgf1HashAlgorithm": "sha512"}, `{"hashAlgorithm":"sha1","mgf1HashAlgorithm":"sha512","modulusLength":1024,"publicExponent":"65537","saltLength":20}`},
		{"ec", map[string]any{"namedCurve": "secp256k1"}, `{"namedCurve":"secp256k1"}`},
		{"ec", map[string]any{"namedCurve": "secp521r1"}, `{"namedCurve":"secp521r1"}`},
	} {
		pair := mustCall(t, ctx, KeyGenerate, c.typ, c.options).(map[string]string)
		k := parseKey(t, unb64(pair["privateKey"]), "der", "pkcs8", nil, false)
		if k.AsymmetricKeyType != c.typ || jsonString(k.Details) != c.details {
			t.Fatalf("%s %v: %+v", c.typ, c.options, k)
		}
		if parseKey(t, unb64(pair["privateKey"]), "der", "pkcs8", nil, true).Der != pair["publicKey"] {
			t.Fatalf("%s: public key", c.typ)
		}
		sig := mustBytes(t, ctx, Sign, nil, []byte("data"), unb64(pair["privateKey"]), map[string]any{})
		if !mustCall(t, ctx, Verify, nil, []byte("data"), unb64(pair["publicKey"]), sig, map[string]any{}).(bool) {
			t.Fatalf("%s: signature", c.typ)
		}
	}

	_, err := call(ctx, KeyGenerate, "rsa", map[string]any{"modulusLength": 256})
	expectError(t, err, "Error|")
	_, err = call(ctx, KeyGenerate, "rsa", map[string]any{"modulusLength": 512, "publicExponent": 4})
	expectError(t, err, "Error|")
	_, err = call(ctx, KeyGenerate, "ec", map[string]any{"namedCurve": "foo"})
	expectError(t, err, "TypeError|ERR_CRYPTO_INVALID_CURVE")
	_, err = call(ctx, KeyGenerate, "foo", map[string]any{})
	expectError(t, err, "TypeError|ERR_INVALID_ARG_VALUE")
	_, err = call(ctx, KeyGenerate, "rsa-pss", map[string]any{"modulusLength": 512, "hashAlgorithm": "foo"})
	expectError(t, err, "TypeError|ERR_CRYPTO_INVALID_DIGEST")
}

// createPublicKey takes a certificate
func TestCertificatePublicKey(t *testing.T) {
	key, _ := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	template := &x509.Certificate{SerialNumber: big.NewInt(1), Subject: pkix.Name{CommonName: "test"}, NotBefore: time.Now(), NotAfter: time.Now().Add(time.Hour)}
	cert, err := x509.CreateCertificate(rand.Reader, template, template, &key.PublicKey, key)
	if err != nil {
		t.Fatal(err)
	}
	spki, _ := x509.MarshalPKIXPublicKey(&key.PublicKey)
	certPem := string(pem.EncodeToMemory(&pem.Block{Type: "CERTIFICATE", Bytes: cert}))

	if got := parseKey(t, certPem, "pem", nil, nil, true); string(unb64(got.Der)) != string(spki) {
		t.Fatalf("certificate key %+v", got)
	}
	_, err = call(newTestContext(), KeyParse, certPem, "pem", nil, nil, false)
	expectError(t, err, "Error|ERR_OSSL_UNSUPPORTED")
}
