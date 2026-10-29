package crypto

import (
	"bytes"
	"testing"
)

func TestRsaCrypt(t *testing.T) {
	ctx := newTestContext()
	priv := keyDER(t, nodeVectors["rsa.pkcs1"], "pem", nil, nil, false)
	pub := keyDER(t, nodeVectors["rsa.pkcs1"], "pem", nil, nil, true)

	decrypt := func(name string, padding int, hash any, label []byte, ciphertext string, want []byte) {
		t.Helper()
		got := mustBytes(t, ctx, RsaCrypt, "privateDecrypt", priv, unhex(ciphertext), padding, hash, label)
		if !bytes.Equal(got, want) {
			t.Fatalf("%s: %x", name, got)
		}
	}
	decrypt("oaep sha256 label", 4, "sha256", []byte("label"), nodeVectors["rsa.oaep.sha256.label"], message)
	decrypt("oaep sha1", 4, nil, nil, nodeVectors["rsa.oaep.sha1"], message)
	decrypt("pkcs1", 1, nil, nil, nodeVectors["rsa.pkcs1enc"], message)

	// bad PKCS#1 v1.5 padding gives OpenSSL's implicit rejection message
	garbage := fill(128, 1)
	garbage[0] = 0
	expectHex(t, "implicit rejection", mustBytes(t, ctx, RsaCrypt, "privateDecrypt", priv, garbage, 1), nodeVectors["rsa.implicit.garbage"])
	expectHex(t, "implicit rejection short", mustBytes(t, ctx, RsaCrypt, "privateDecrypt", priv, fill(10, 1), 1), nodeVectors["rsa.implicit.short"])

	// private encrypt (type 1 padding) is deterministic
	expectHex(t, "privateEncrypt", mustBytes(t, ctx, RsaCrypt, "privateEncrypt", priv, message, 1), nodeVectors["rsa.privenc.pkcs1"])
	if got := mustBytes(t, ctx, RsaCrypt, "publicDecrypt", pub, unhex(nodeVectors["rsa.privenc.pkcs1"]), 1); !bytes.Equal(got, message) {
		t.Fatalf("publicDecrypt %x", got)
	}

	raw := unhex(nodeVectors["rsa.raw.in"])
	expectHex(t, "privateEncrypt none", mustBytes(t, ctx, RsaCrypt, "privateEncrypt", priv, raw, 3), nodeVectors["rsa.privenc.none"])
	expectHex(t, "publicEncrypt none", mustBytes(t, ctx, RsaCrypt, "publicEncrypt", pub, raw, 3), nodeVectors["rsa.pubenc.none"])
	expectHex(t, "privateDecrypt none", mustBytes(t, ctx, RsaCrypt, "privateDecrypt", priv, raw, 3), nodeVectors["rsa.privdec.none"])
	expectHex(t, "publicDecrypt none", mustBytes(t, ctx, RsaCrypt, "publicDecrypt", pub, unhex(nodeVectors["rsa.privenc.none"]), 3), nodeVectors["rsa.raw.in"])

	for _, c := range []struct {
		padding int
		hash    any
		label   []byte
	}{{1, nil, nil}, {4, nil, nil}, {4, "sha256", []byte("l")}} {
		ciphertext := mustBytes(t, ctx, RsaCrypt, "publicEncrypt", pub, message, c.padding, c.hash, c.label)
		if got := mustBytes(t, ctx, RsaCrypt, "privateDecrypt", priv, ciphertext, c.padding, c.hash, c.label); !bytes.Equal(got, message) {
			t.Fatalf("round trip %d: %x", c.padding, got)
		}
	}

	_, err := call(ctx, RsaCrypt, "publicEncrypt", pub, make([]byte, 118), 1)
	expectError(t, err, "Error|ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE")
	_, err = call(ctx, RsaCrypt, "publicEncrypt", pub, make([]byte, 100), 4)
	expectError(t, err, "Error|ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE")
	_, err = call(ctx, RsaCrypt, "publicEncrypt", pub, make([]byte, 100), 3)
	expectError(t, err, "Error|ERR_OSSL_RSA_DATA_TOO_SMALL_FOR_KEY_SIZE")
	_, err = call(ctx, RsaCrypt, "publicEncrypt", pub, bytes.Repeat([]byte{0xff}, 128), 3)
	expectError(t, err, "Error|ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_MODULUS")
	_, err = call(ctx, RsaCrypt, "privateDecrypt", priv, bytes.Repeat([]byte{1}, 128), 4)
	expectError(t, err, "Error|ERR_OSSL_RSA_OAEP_DECODING_ERROR")
	_, err = call(ctx, RsaCrypt, "privateDecrypt", priv, bytes.Repeat([]byte{0xff}, 128), 1)
	expectError(t, err, "Error|ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_MODULUS")
	_, err = call(ctx, RsaCrypt, "publicDecrypt", pub, bytes.Repeat([]byte{1}, 128), 1)
	expectError(t, err, "Error|ERR_OSSL_RSA_INVALID_PADDING")
	_, err = call(ctx, RsaCrypt, "privateEncrypt", priv, make([]byte, 10), 4)
	expectError(t, err, "Error|ERR_OSSL_ILLEGAL_OR_UNSUPPORTED_PADDING_MODE")
	_, err = call(ctx, RsaCrypt, "publicEncrypt", pub, message, 4, "foo")
	expectError(t, err, "Error|ERR_OSSL_EVP_INVALID_DIGEST")

	ec := unhex(nodeVectors["ec.prime256v1.spki"])
	_, err = call(ctx, RsaCrypt, "publicEncrypt", ec, message, 1)
	expectError(t, err, "Error|ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE")
	pss := keyDER(t, nodeVectors["pss.spki"], "pem", nil, nil, true)
	_, err = call(ctx, RsaCrypt, "publicEncrypt", pss, message, 1)
	expectError(t, err, "Error|ERR_OSSL_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE")
}
