package crypto

import (
	"testing"
)

func keyDER(t *testing.T, values ...any) []byte {
	t.Helper()
	return unb64(parseKey(t, values...).Der)
}

func expectVerify(t *testing.T, name string, want bool, values ...any) {
	t.Helper()
	if got := mustCall(t, newTestContext(), Verify, values...).(bool); got != want {
		t.Fatalf("%s: verify %v, want %v", name, got, want)
	}
}

var message = []byte("message to sign")

func TestSignRSA(t *testing.T) {
	ctx := newTestContext()
	priv := keyDER(t, nodeVectors["rsa.pkcs1"], "pem", nil, nil, false)
	pub := keyDER(t, nodeVectors["rsa.pkcs1"], "pem", nil, nil, true)
	none := map[string]any{}

	// PKCS#1 v1.5 is deterministic, the bytes are Node's; no algorithm is
	// SHA-256
	for _, c := range []struct {
		algorithm any
		vector    string
	}{{"sha256", "rsa.sign.sha256"}, {"sha1", "rsa.sign.sha1"}, {nil, "rsa.sign.null"}, {"sha3-256", "rsa.sign.sha3-256"}} {
		expectHex(t, c.vector, mustBytes(t, ctx, Sign, c.algorithm, message, priv, none), nodeVectors[c.vector])
		expectVerify(t, c.vector, true, c.algorithm, message, pub, unhex(nodeVectors[c.vector]), none)
		expectVerify(t, c.vector+" with the private key", true, c.algorithm, message, priv, unhex(nodeVectors[c.vector]), none)
		expectVerify(t, c.vector+" other data", false, c.algorithm, []byte("other"), pub, unhex(nodeVectors[c.vector]), none)
	}

	pss := map[string]any{"padding": 6}
	expectVerify(t, "pss max", true, "sha256", message, pub, unhex(nodeVectors["rsa.pss.sha256.max"]), pss)
	expectVerify(t, "pss max as digest", false, "sha256", message, pub, unhex(nodeVectors["rsa.pss.sha256.max"]), map[string]any{"padding": 6, "saltLength": -1})
	expectVerify(t, "pss digest", true, "sha384", message, pub, unhex(nodeVectors["rsa.pss.sha384.digest"]), map[string]any{"padding": 6, "saltLength": -1})
	expectVerify(t, "pss digest auto", true, "sha384", message, pub, unhex(nodeVectors["rsa.pss.sha384.digest"]), pss)

	// a salt of 0 makes PSS deterministic: the raw path gives Node's bytes
	salt0 := map[string]any{"padding": 6, "saltLength": 0}
	expectHex(t, "pss salt 0", mustBytes(t, ctx, Sign, "sha256", message, priv, salt0), nodeVectors["rsa.pss.sha256.0"])
	expectVerify(t, "pss salt 0", true, "sha256", message, pub, unhex(nodeVectors["rsa.pss.sha256.0"]), salt0)
	expectVerify(t, "pss salt 0 auto", true, "sha256", message, pub, unhex(nodeVectors["rsa.pss.sha256.0"]), pss)

	for _, options := range []map[string]any{pss, {"padding": 6, "saltLength": -1}, {"padding": 6, "saltLength": 7}} {
		sig := mustBytes(t, ctx, Sign, "sha384", message, priv, options)
		expectVerify(t, "pss round trip", true, "sha384", message, pub, sig, options)
	}

	_, err := call(ctx, Sign, "sha256", message, priv, map[string]any{"padding": 6, "saltLength": 200})
	expectError(t, err, "Error|ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE")
	_, err = call(ctx, Sign, "sha256", message, priv, map[string]any{"padding": 3})
	expectError(t, err, "Error|ERR_OSSL_INVALID_PADDING_MODE")
	_, err = call(ctx, Sign, "foo", message, priv, none)
	expectError(t, err, "TypeError|ERR_CRYPTO_INVALID_DIGEST")
	_, err = call(ctx, Sign, "sha256", message, pub, none)
	expectError(t, err, "Error|ERR_OSSL_UNSUPPORTED")
}

func TestSignRSAPSSKeys(t *testing.T) {
	ctx := newTestContext()
	priv := keyDER(t, nodeVectors["pss.pkcs8"], "pem", nil, nil, false)
	pub := keyDER(t, nodeVectors["pss.spki"], "pem", nil, nil, true)
	none := map[string]any{}

	// the key's parameters: SHA-256, MGF1 SHA-1, salt 24 exactly by default
	expectVerify(t, "restricted", true, nil, message, pub, unhex(nodeVectors["pss.sign"]), none)
	expectVerify(t, "restricted sha256", true, "sha256", message, pub, unhex(nodeVectors["pss.sign"]), none)
	expectVerify(t, "restricted salt 30 default", false, nil, message, pub, unhex(nodeVectors["pss.sign.salt30"]), none)
	expectVerify(t, "restricted salt 30", true, nil, message, pub, unhex(nodeVectors["pss.sign.salt30"]), map[string]any{"saltLength": 30})

	sig := mustBytes(t, ctx, Sign, nil, message, priv, none)
	expectVerify(t, "restricted round trip", true, nil, message, pub, sig, none)
	sig = mustBytes(t, ctx, Sign, nil, message, priv, map[string]any{"saltLength": 40})
	expectVerify(t, "restricted round trip salt 40", true, nil, message, pub, sig, map[string]any{"saltLength": 40})

	_, err := call(ctx, Sign, nil, message, priv, map[string]any{"saltLength": 10})
	expectError(t, err, "Error|ERR_OSSL_PSS_SALTLEN_TOO_SMALL")
	_, err = call(ctx, Sign, "sha512", message, priv, none)
	expectError(t, err, "Error|ERR_OSSL_DIGEST_NOT_ALLOWED")
	_, err = call(ctx, Sign, nil, message, priv, map[string]any{"padding": 1})
	expectError(t, err, "Error|ERR_OSSL_ILLEGAL_OR_UNSUPPORTED_PADDING_MODE")

	unrestricted := keyDER(t, nodeVectors["pssu.pkcs8"], "pem", nil, nil, false)
	salt0 := map[string]any{"saltLength": 0}
	expectHex(t, "unrestricted salt 0", mustBytes(t, ctx, Sign, nil, message, unrestricted, salt0), nodeVectors["pssu.sign.0"])
	expectVerify(t, "unrestricted salt 0", true, "sha256", message, unrestricted, unhex(nodeVectors["pssu.sign.0"]), salt0)
}

func TestSignEC(t *testing.T) {
	ctx := newTestContext()
	p1363 := map[string]any{"dsaEncoding": "ieee-p1363"}
	none := map[string]any{}
	for _, curve := range curves {
		name := curve.name
		priv := keyDER(t, nodeVectors["ec."+name+".sec1"], "pem", nil, nil, false)
		pub := unhex(nodeVectors["ec."+name+".spki"])

		expectVerify(t, name, true, "sha384", message, pub, unhex(nodeVectors["ec."+name+".sig"]), none)
		expectVerify(t, name+" p1363", true, "sha256", message, pub, unhex(nodeVectors["ec."+name+".sig.p1363"]), p1363)
		expectVerify(t, name+" p1363 as der", false, "sha256", message, pub, unhex(nodeVectors["ec."+name+".sig.p1363"]), none)
		expectVerify(t, name+" other digest", false, "sha256", message, pub, unhex(nodeVectors["ec."+name+".sig"]), none)
		expectVerify(t, name+" garbage", false, "sha256", message, pub, []byte("garbage"), none)

		for _, options := range []map[string]any{none, p1363} {
			sig := mustBytes(t, ctx, Sign, nil, message, priv, options)
			expectVerify(t, name+" round trip", true, "sha256", message, pub, sig, options)
			expectVerify(t, name+" round trip other", false, "sha256", []byte("other"), pub, sig, options)
		}
		// long digests are truncated to the order
		sig := mustBytes(t, ctx, Sign, "sha512", message, priv, none)
		expectVerify(t, name+" sha512", true, "sha512", message, pub, sig, none)
	}
}

func TestSignEdDSA(t *testing.T) {
	ctx := newTestContext()
	none := map[string]any{}
	okp := func(crv, d string) []byte {
		return keyDER(t, map[string]any{"kty": "OKP", "crv": crv, "d": b64url(unhex(d))}, "jwk", nil, nil, false)
	}

	// RFC 8032 7.1 tests 1 and 2
	for _, c := range []struct{ secret, message, signature string }{
		{"9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "",
			"e5564300c360ac729086e2cc806e828a84877f1eb8e5d974d873e065224901555fb8821590a33bacc61e39701cf9b46bd25bf5f0595bbe24655141438e7a100b"},
		{"4ccd089b28ff96da9db6c346ec114e0f5b8a319f35aba624da8cf6ed4fb8a6fb", "72",
			"92a009a9f0d4cab8720e820b5f642540a2b27b5416503f8fb3762223ebdb69da085ac1e43e15996e458f3613d0f11d8c387b2eaeb4302aeeb00d291612bb0c00"},
	} {
		priv := okp("Ed25519", c.secret)
		expectHex(t, "ed25519", mustBytes(t, ctx, Sign, nil, unhex(c.message), priv, none), c.signature)
		expectVerify(t, "ed25519", true, nil, unhex(c.message), priv, unhex(c.signature), none)
		expectVerify(t, "ed25519 other", false, nil, []byte("x"), priv, unhex(c.signature), none)
	}

	// RFC 8032 7.4, the empty message, and Node's signature of "abc"
	ed448 := okp("Ed448", "6c82a562cb808d10d632be89c8513ebf6c929f34ddfa8c9f63c9960ef6e348a3528c8a3fcc2f044e39a3fc5b94492f8f032e7549a20098f95b")
	expectHex(t, "ed448", mustBytes(t, ctx, Sign, nil, []byte{}, ed448, none),
		"533a37f6bbe457251f023c0d88f976ae2dfb504a843e34d2074fd823d41a591f2b233f034f628281f2fd7a22ddd47d7828c59bd0a21bfd3980ff0d2028d4b18a9df63e006c5d1c2d345b925d8dc00b4104852db99ac5c7cdda8530a113a0f4dbb61149f05a7363268c71d95808ff2e652600")
	expectHex(t, "ed448 abc", mustBytes(t, ctx, Sign, nil, []byte("abc"), ed448, none), nodeVectors["ed448.sign.abc"])
	expectVerify(t, "ed448", true, nil, []byte("abc"), ed448, unhex(nodeVectors["ed448.sign.abc"]), none)

	_, err := call(ctx, Sign, "sha256", message, ed448, none)
	expectError(t, err, "Error|ERR_OSSL_INVALID_DIGEST")
	x25519 := okp("X25519", "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
	_, err = call(ctx, Sign, nil, message, x25519, none)
	expectError(t, err, "Error|ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE")
}
