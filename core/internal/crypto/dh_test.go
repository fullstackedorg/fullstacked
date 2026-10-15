package crypto

import (
	"bytes"
	"encoding/binary"
	"math/big"
	"testing"
)

func TestDiffieHellmanKeys(t *testing.T) {
	ctx := newTestContext()
	for _, curve := range curves {
		name := curve.name
		priv := keyDER(t, nodeVectors["ec."+name+".sec1"], "pem", nil, nil, false)
		peer := unhex(nodeVectors["ec."+name+".peer.spki"])
		expectHex(t, name, mustBytes(t, ctx, DiffieHellman, priv, peer), nodeVectors["ec."+name+".dh"])
	}

	okp := func(crv, d string) []byte {
		return keyDER(t, map[string]any{"kty": "OKP", "crv": crv, "d": b64url(unhex(d))}, "jwk", nil, nil, false)
	}
	okpPublic := func(crv, x string) []byte {
		return keyDER(t, map[string]any{"kty": "OKP", "crv": crv, "x": b64url(unhex(x))}, "jwk", nil, nil, true)
	}

	// RFC 7748 6.1 and 6.2
	alice := okp("X25519", "77076d0a7318a57d3c16c17251b26645df4c2f87ebc0992ab177fba51db92c2a")
	bob := okpPublic("X25519", "de9edb7d7b7dc1b4d35b61c2ece435373f8343c85b78674dadfc7e146f882b4f")
	expectHex(t, "x25519", mustBytes(t, ctx, DiffieHellman, alice, bob), "4a5d9d5ba4ce2de1728e3bf480350f25e07e21c947d19e3376f09b3c1e161742")
	expectHex(t, "x25519 public", keyDER(t, alice, "der", "pkcs8", nil, true)[12:],
		"8520f0098930a754748b7ddcb43ef75a0dbf3a0d26381af4eba4a98eaa9b4e6a")

	alice448 := okp("X448", "9a8f4925d1519f5775cf46b04b5800d4ee9ee8bae8bc5565d498c28dd9c9baf574a9419744897391006382a6f127ab1d9ac2d8c0a598726b")
	bob448 := okpPublic("X448", "3eb7a829b0cd20f5bcfc0b599b6feccf6da4627107bdb0d4f345b43027d8b972fc3e34fb4232a13ca706dcb57aec3dae07bdc1c67bf33609")
	expectHex(t, "x448", mustBytes(t, ctx, DiffieHellman, alice448, bob448),
		"07fff4181ac6cc95ec1c16a94a0f74d12da232ce40a77552281d282bb60c0b56fd2464c335543936521c24403085d59a449a5037514a879d")

	_, err := call(ctx, DiffieHellman, alice, bob448)
	expectError(t, err, "Error|ERR_CRYPTO_INCOMPATIBLE_KEY")
	ed := okp("Ed25519", "9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60")
	_, err = call(ctx, DiffieHellman, ed, ed)
	expectError(t, err, "Error|ERR_CRYPTO_INCOMPATIBLE_KEY")
	_, err = call(ctx, DiffieHellman, alice, okpPublic("X25519", "0000000000000000000000000000000000000000000000000000000000000000"))
	expectError(t, err, "Error|ERR_OSSL_FAILED_DURING_DERIVATION")
	p256 := keyDER(t, nodeVectors["ec.prime256v1.sec1"], "pem", nil, nil, false)
	_, err = call(ctx, DiffieHellman, p256, unhex(nodeVectors["ec.secp384r1.peer.spki"]))
	expectError(t, err, "Error|ERR_OSSL_MISMATCHING_DOMAIN_PARAMETERS")
}

func splitKeys(out []byte) ([]byte, []byte) {
	n := binary.BigEndian.Uint32(out)
	return out[4 : 4+n], out[4+n:]
}

func TestClassicDH(t *testing.T) {
	ctx := newTestContext()
	sizes := map[string]int{"modp1": 96, "modp2": 128, "modp5": 192, "modp14": 256, "modp15": 384, "modp16": 512, "modp17": 768, "modp18": 1024}
	for name, size := range sizes {
		prime := mustBytes(t, ctx, DhGroup, name)
		if len(prime) != size || !new(big.Int).SetBytes(prime).ProbablyPrime(2) {
			t.Fatalf("%s: %d bytes", name, len(prime))
		}
	}
	_, err := call(ctx, DhGroup, "modp3")
	expectError(t, err, "Error|ERR_CRYPTO_UNKNOWN_DH_GROUP")

	prime := mustBytes(t, ctx, DhGroup, "modp2")
	g := []byte{2}
	pubA, privA := splitKeys(mustBytes(t, ctx, DhGenerate, prime, g, bytes.Repeat([]byte{0x11}, 20)))
	expectHex(t, "public A", pubA, nodeVectors["dh.modp2.pubA"])
	expectHex(t, "private A", privA, "1111111111111111111111111111111111111111")
	pubB, _ := splitKeys(mustBytes(t, ctx, DhGenerate, prime, g, bytes.Repeat([]byte{0x22}, 20)))
	expectHex(t, "public B", pubB, nodeVectors["dh.modp2.pubB"])
	expectHex(t, "secret", mustBytes(t, ctx, DhCompute, prime, privA, pubB), nodeVectors["dh.modp2.secret"])

	// the secret is padded to the prime size, Node's leading zeros
	if secret := mustBytes(t, ctx, DhCompute, prime, []byte{1}, []byte{2}); len(secret) != 128 || secret[127] != 2 {
		t.Fatalf("padded secret %x", secret)
	}

	// generated private keys have OpenSSL's length for the group
	prime14 := mustBytes(t, ctx, DhGroup, "modp14")
	for range 5 {
		pub, priv := splitKeys(mustBytes(t, ctx, DhGenerate, prime14, g))
		if new(big.Int).SetBytes(priv).BitLen() > 225 || len(pub) > 256 {
			t.Fatalf("modp14 private key of %d bits", new(big.Int).SetBytes(priv).BitLen())
		}
		secret := mustBytes(t, ctx, DhCompute, prime14, priv, pubB[:64])
		if len(secret) != 256 {
			t.Fatalf("secret %d bytes", len(secret))
		}
	}

	pMinus1 := new(big.Int).Sub(new(big.Int).SetBytes(prime), big.NewInt(1)).Bytes()
	_, err = call(ctx, DhCompute, prime, privA, []byte{1})
	expectError(t, err, "RangeError|ERR_CRYPTO_INVALID_KEYLEN")
	_, err = call(ctx, DhCompute, prime, privA, pMinus1)
	expectError(t, err, "RangeError|ERR_CRYPTO_INVALID_KEYLEN")
	_, err = call(ctx, DhGenerate, prime, []byte{1})
	expectError(t, err, "Error|ERR_OSSL_DH_BAD_GENERATOR")
}

func TestECDH(t *testing.T) {
	ctx := newTestContext()
	for _, name := range []string{"secp256k1", "prime256v1", "secp224r1", "secp521r1"} {
		curve := curveByName(name)
		privA := bytes.Repeat([]byte{7}, curve.size)
		privB := bytes.Repeat([]byte{9}, curve.size)
		if curve.size == 66 {
			privA[0], privB[0] = 1, 1
		}

		pubA, priv := splitKeys(mustBytes(t, ctx, EcdhGenerate, name, privA))
		expectHex(t, name+" public", pubA, nodeVectors["ecdh."+name+".pubA"])
		if !bytes.Equal(priv, privA) {
			t.Fatalf("%s private %x", name, priv)
		}
		for _, encoding := range []string{"compressed", "hybrid"} {
			pubB := unhex(nodeVectors["ecdh."+name+".pubB."+encoding])
			expectHex(t, name+" secret "+encoding, mustBytes(t, ctx, EcdhCompute, name, privA, pubB), nodeVectors["ecdh."+name+".secret"])
		}

		// encodings convert both ways
		compressed := unhex(nodeVectors["ecdh."+name+".pubB.compressed"])
		uncompressed := mustBytes(t, ctx, EcdhConvertKey, name, compressed, "uncompressed")
		expectHex(t, name+" hybrid", mustBytes(t, ctx, EcdhConvertKey, name, uncompressed, "hybrid"), nodeVectors["ecdh."+name+".pubB.hybrid"])
		expectHex(t, name+" compressed", mustBytes(t, ctx, EcdhConvertKey, name, uncompressed, "compressed"), nodeVectors["ecdh."+name+".pubB.compressed"])

		// a private key comes with or without leading zeros
		pubLong, _ := splitKeys(mustBytes(t, ctx, EcdhGenerate, name, append(make([]byte, 3), privA...)))
		if !bytes.Equal(pubLong, pubA) {
			t.Fatalf("%s: leading zeros changed the key", name)
		}
		_, privShort := splitKeys(mustBytes(t, ctx, EcdhGenerate, name, []byte{5}))
		if len(privShort) != curve.size || privShort[curve.size-1] != 5 {
			t.Fatalf("%s short private %x", name, privShort)
		}

		// random keys agree
		pub1, priv1 := splitKeys(mustBytes(t, ctx, EcdhGenerate, name))
		pub2, priv2 := splitKeys(mustBytes(t, ctx, EcdhGenerate, name))
		if !bytes.Equal(mustBytes(t, ctx, EcdhCompute, name, priv1, pub2), mustBytes(t, ctx, EcdhCompute, name, priv2, pub1)) {
			t.Fatalf("%s: random keys disagree", name)
		}

		_, err := call(ctx, EcdhCompute, name, privA, []byte{4, 1, 2})
		expectError(t, err, "Error|ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY")
		_, err = call(ctx, EcdhCompute, name, privA, []byte{})
		expectError(t, err, "Error|ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY")
		_, err = call(ctx, EcdhGenerate, name, make([]byte, curve.size))
		expectError(t, err, "RangeError|ERR_CRYPTO_INVALID_KEYTYPE")
		_, err = call(ctx, EcdhGenerate, name, bytes.Repeat([]byte{0xff}, curve.size))
		expectError(t, err, "RangeError|ERR_CRYPTO_INVALID_KEYTYPE")
		_, err = call(ctx, EcdhConvertKey, name, []byte{4, 1, 2}, "compressed")
		expectError(t, err, "Error|ERR_CRYPTO_OPERATION_FAILED")
	}

	_, err := call(ctx, EcdhGenerate, "foo")
	expectError(t, err, "TypeError|ERR_CRYPTO_INVALID_CURVE")
}
