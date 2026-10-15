package crypto

import (
	"bytes"
	"testing"
)

func TestPbkdf2(t *testing.T) {
	ctx := newTestContext()
	// RFC 6070
	for _, c := range []struct {
		password, salt string
		iterations     int
		keylen         int
		want           string
	}{
		{"password", "salt", 1, 20, "0c60c80f961f0e71f3a9b524af6012062fe037a6"},
		{"password", "salt", 2, 20, "ea6c014dc72d6f8ccd1ed92ace1d41f0d8de8957"},
		{"password", "salt", 4096, 20, "4b007901b765489abead49d926f721d065a429c1"},
		{"passwordPASSWORDpassword", "saltSALTsaltSALTsaltSALTsaltSALTsalt", 4096, 25, "3d2eec4fe41c849b80c8d83662c0e44a8b291a964cf2f07038"},
		{"pass\x00word", "sa\x00lt", 4096, 16, "56fa6aa75548099dcc37d7f03425e0c3"},
	} {
		expectHex(t, "pbkdf2", mustBytes(t, ctx, Pbkdf2, []byte(c.password), []byte(c.salt), c.iterations, c.keylen, "sha1"), c.want)
	}
	expectHex(t, "pbkdf2 sha512", mustBytes(t, ctx, Pbkdf2, []byte("password"), []byte("salt"), 1000, 64, "sha512"), nodeVectors["pbkdf2.sha512"])
	expectHex(t, "pbkdf2 sha3-256", mustBytes(t, ctx, Pbkdf2, []byte("password"), []byte("salt"), 10, 40, "sha3-256"), nodeVectors["pbkdf2.sha3-256"])

	_, err := call(ctx, Pbkdf2, []byte("a"), []byte("b"), 1, 10, "foo")
	expectError(t, err, "TypeError|ERR_CRYPTO_INVALID_DIGEST")
	_, err = call(ctx, Pbkdf2, []byte("a"), []byte("b"), 1, 0, "sha256")
	expectError(t, err, "Error|")
	_, err = call(ctx, Pbkdf2, []byte("a"), []byte("b"), 1, 10, "shake128")
	expectError(t, err, "Error|")
}

func TestHkdf(t *testing.T) {
	ctx := newTestContext()
	// RFC 5869 test cases 1 and 3
	expectHex(t, "hkdf 1", mustBytes(t, ctx, Hkdf, "sha256", bytes.Repeat([]byte{0x0b}, 22), unhex("000102030405060708090a0b0c"), unhex("f0f1f2f3f4f5f6f7f8f9"), 42),
		"3cb25f25faacd57a90434f64d0362f2a2d2d0a90cf1a5a4c5db02d56ecc4c5bf34007208d5b887185865")
	expectHex(t, "hkdf 3", mustBytes(t, ctx, Hkdf, "sha256", bytes.Repeat([]byte{0x0b}, 22), []byte{}, []byte{}, 42),
		"8da4e775a563c18f715f802a063c5a31b8a11f5c5ee1879ec3454e5f3c738d2d9d201395faa4b61a96c8")
	expectHex(t, "hkdf sha512", mustBytes(t, ctx, Hkdf, "sha512", []byte("ikm"), []byte("salt"), []byte("info"), 100), nodeVectors["hkdf.sha512"])

	_, err := call(ctx, Hkdf, "sha256", []byte("a"), []byte("b"), []byte("c"), 255*32+1)
	expectError(t, err, "RangeError|ERR_CRYPTO_INVALID_KEYLEN")
	_, err = call(ctx, Hkdf, "foo", []byte("a"), []byte("b"), []byte("c"), 10)
	expectError(t, err, "TypeError|ERR_CRYPTO_INVALID_DIGEST")
	_, err = call(ctx, Hkdf, "sha256", []byte("a"), []byte("b"), []byte("c"), 0)
	expectError(t, err, "Error|")
}

func TestScrypt(t *testing.T) {
	ctx := newTestContext()
	options := func(n, r, p int) map[string]any {
		return map[string]any{"N": n, "r": r, "p": p, "maxmem": 32 << 20}
	}
	// RFC 7914 section 12
	expectHex(t, "scrypt 1", mustBytes(t, ctx, Scrypt, []byte{}, []byte{}, 64, options(16, 1, 1)),
		"77d6576238657b203b19ca42c18a0497f16b4844e3074ae8dfdffa3fede21442fcd0069ded0948f8326a753a0fc81f17e8d3e0fb2e0d3628cf35e20c38d18906")
	expectHex(t, "scrypt 2", mustBytes(t, ctx, Scrypt, []byte("password"), []byte("NaCl"), 64, options(1024, 8, 16)),
		"fdbabe1c9d3472007856e7190d01e9fe7c6ad7cbc8237830e77376634b3731622eaf30d92e22a3886ff109279d9830dac727afb94a83ee6d8360cbdfa2cc0640")
	expectHex(t, "scrypt node", mustBytes(t, ctx, Scrypt, []byte("password"), []byte("salt"), 32, options(16384, 8, 1)), nodeVectors["scrypt.default"])
	expectHex(t, "scrypt 0", mustBytes(t, ctx, Scrypt, []byte("a"), []byte("b"), 0, options(16, 1, 1)), "")

	_, err := call(ctx, Scrypt, []byte("a"), []byte("b"), 10, options(3, 1, 1))
	expectError(t, err, "RangeError|ERR_CRYPTO_INVALID_SCRYPT_PARAMS")
	_, err = call(ctx, Scrypt, []byte("a"), []byte("b"), 10, options(1<<20, 8, 1))
	expectError(t, err, "RangeError|ERR_CRYPTO_INVALID_SCRYPT_PARAMS")
}
