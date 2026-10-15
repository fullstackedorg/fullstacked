package crypto

import (
	"bytes"
	"crypto/aes"
	"encoding/binary"
	"encoding/hex"
	"strings"
	"testing"
)

// NIST SP 800-38A, AES-128, the four blocks of F.1 to F.5
func TestCipherSP80038A(t *testing.T) {
	ctx := newTestContext()
	key := unhex("2b7e151628aed2a6abf7158809cf4f3c")
	iv := unhex("000102030405060708090a0b0c0d0e0f")
	plaintext := unhex("6bc1bee22e409f96e93d7e117393172a ae2d8a571e03ac9c9eb76fac45af8e51 30c81c46a35ce411e5fbc1191a0a52ef f69f2445df4f9b17ad2b417be66c3710")

	for _, c := range []struct {
		algorithm string
		iv        []byte
		want      string
	}{
		{"aes-128-ecb", nil, "3ad77bb40d7a3660a89ecaf32466ef97 f5d3d58503b9699de785895a96fdbaaf 43b1cd7f598ece23881b00e3ed030688 7b0c785e27e8ad3f8223207104725dd4"},
		{"aes-128-cbc", iv, "7649abac8119b246cee98e9b12e9197d 5086cb9b507219ee95db113a917678b2 73bed6b8e3c1743b7116e69e22229516 3ff1caa1681fac09120eca307586e1a7"},
		{"aes-128-cfb", iv, "3b3fd92eb72dad20333449f8e83cfb4a c8a64537a0b3a93fcde3cdad9f1ce58b 26751f67a3cbb140b1808cf187a4f4df c04b05357c5d1c0eeac4c66f9ff7f2e6"},
		{"aes-128-ofb", iv, "3b3fd92eb72dad20333449f8e83cfb4a 7789508d16918f03f53c52dac54ed825 9740051e9c5fecf64344f7a82260edcc 304c6528f659c77866a510d9c1d6ae5e"},
		{"aes-128-ctr", unhex("f0f1f2f3f4f5f6f7f8f9fafbfcfdfeff"), "874d6191b620e3261bef6864990db6ce 9806f66b7970fdff8617187bb9fffdff 5ae4df3edbd5d35e5b4f09020db03eab 1e031dda2fbe03d1792170a0f3009cee"},
	} {
		out := mustBytes(t, ctx, CipherInit, c.algorithm, key, c.iv, false, nil, false, nil, nil, plaintext)
		h := handleOf(t, out)
		final := mustBytes(t, ctx, CipherFinal, h)
		expectHex(t, c.algorithm, append(out[4:], final...), c.want)
	}

	// F.3.7, CFB8 on 18 bytes
	out := mustBytes(t, ctx, CipherInit, "aes-128-cfb8", key, iv, false, nil, true, nil, nil, plaintext[:18])
	expectHex(t, "aes-128-cfb8", out[4:], "3b79424c9c0dd436bace9e0ed4586a4f32b9")
	mustCall(t, ctx, CipherFinal, handleOf(t, out))
}

// every update's output must be Node's: OpenSSL holds back the last block
// when decrypting with padding, the stream modes and GCM output at once
func TestCipherNodeUpdates(t *testing.T) {
	ctx := newTestContext()
	for i, v := range nodeCipherVectors {
		name := v.algorithm
		if v.decrypt {
			name += " decrypt"
		}
		if !v.padding {
			name += " nopad"
		}

		aead := strings.Contains(v.algorithm, "gcm") || strings.Contains(v.algorithm, "poly")
		var tagLen, aad, tagAtInit any
		if aead {
			tagLen, aad = 16, []byte("aad")
			if strings.Contains(v.algorithm, "gcm") {
				tagLen = 12
			}
			// the tag either comes with the init or with final
			if v.decrypt && i%2 == 0 {
				tagAtInit = unhex(v.tag)
			}
		}
		var iv any
		if v.iv != "" {
			iv = unhex(v.iv)
		}

		out := mustBytes(t, ctx, CipherInit, v.algorithm, unhex(v.key), iv, v.decrypt, tagLen, v.padding, aad, tagAtInit)
		h := handleOf(t, out)
		if len(out) != 4 {
			t.Fatalf("%s: init output %x", name, out[4:])
		}

		input := unhex(v.input)
		chunks := []int{5, 11, 16, 3, 29, 0, 17, 64, 1}
		offset := 0
		for j, want := range v.outputs {
			end := len(input)
			if j < len(chunks) {
				end = min(offset+chunks[j], len(input))
			}
			got := mustBytes(t, ctx, CipherUpdate, h, input[offset:end])
			offset = end
			expectHex(t, name+" update", got, want)
		}

		var finalTag any
		if v.decrypt && aead && tagAtInit == nil {
			finalTag = unhex(v.tag)
		}
		final := mustBytes(t, ctx, CipherFinal, h, finalTag)
		expectHex(t, name+" final", final, v.final+v.outTag)

		if !aead {
			continue
		}

		// the one-shot gives the same bytes
		var tag any
		if v.decrypt {
			tag = unhex(v.tag)
		}
		oneShot := mustBytes(t, ctx, Aead, v.algorithm, unhex(v.key), iv, v.decrypt, tagLen, aad, tag, input)
		status := byte(0)
		if v.decrypt {
			status = 1
		}
		expectHex(t, name+" one-shot", oneShot, hex.EncodeToString([]byte{status})+strings.Join(v.outputs, "")+v.final+v.outTag)

		if v.decrypt {
			bad := unhex(v.tag)
			bad[0] ^= 1
			oneShot = mustBytes(t, ctx, Aead, v.algorithm, unhex(v.key), iv, true, tagLen, aad, bad, input)
			expectHex(t, name+" one-shot bad tag", oneShot, "02"+strings.Join(v.outputs, ""))
			oneShot = mustBytes(t, ctx, Aead, v.algorithm, unhex(v.key), iv, true, tagLen, aad, nil, input)
			expectHex(t, name+" one-shot no tag", oneShot, "00"+strings.Join(v.outputs, ""))

			out := mustBytes(t, ctx, CipherInit, v.algorithm, unhex(v.key), iv, true, tagLen, true, aad, bad, input)
			_, err := call(ctx, CipherFinal, handleOf(t, out))
			expectError(t, err, "Error|")
		}
	}

	if len(ctx.Crypto) != 0 {
		t.Fatalf("handles left: %d", len(ctx.Crypto))
	}
}

// McGrew and Viega's GCM test cases 2, 4, 5 (8-byte IV) and 6 (60-byte IV)
func TestGCMVectors(t *testing.T) {
	ctx := newTestContext()
	key := unhex("feffe9928665731c6d6a8f9467308308")
	plaintext := unhex("d9313225f88406e5a55909c5aff5269a86a7a9531534f7da2e4c303d8a318a721c3c0c95956809532fcf0e2449a6b525b16aedf5aa0de657ba637b39")
	aad := unhex("feedfacedeadbeeffeedfacedeadbeefabaddad2")

	for _, c := range []struct {
		key, iv, plaintext, aad []byte
		want                    string
	}{
		{make([]byte, 16), make([]byte, 12), make([]byte, 16), nil, "0388dace60b6a392f328c2b971b2fe78 ab6e47d42cec13bdf53a67b21257bddf"},
		{key, unhex("cafebabefacedbaddecaf888"), plaintext, aad, "42831ec2217774244b7221b784d0d49ce3aa212f2c02a4e035c17e2329aca12e21d514b25466931c7d8f6a5aac84aa051ba30b396a0aac973d58e091 5bc94fbc3221a5db94fae95ae7121a47"},
		{key, unhex("cafebabefacedbad"), plaintext, aad, "61353b4c2806934a777ff51fa22a4755699b2a714fcdc6f83766e5f97b6c742373806900e49f24b22b097544d4896b424989b5e1ebac0f07c23f4598 3612d2e79e3b0785561be14aaca2fccb"},
		{key, unhex("9313225df88406e555909c5aff5269aa6a7a9538534f7da1e4c303d2a318a728c3c0c95156809539fcf0e2429a6b525416aedbf5a0de6a57a637b39b"), plaintext, aad, "8ce24998625615b603a033aca13fb894be9112a5c3a211a8ba262a3cca7e2ca701e4a9a4fba43c90ccdcb281d48c7c6fd62875d2aca417034c34aee5 619cc5aefffe0bfa462af43c1699d050"},
	} {
		out := mustBytes(t, ctx, Aead, "aes-128-gcm", c.key, c.iv, false, nil, c.aad, nil, c.plaintext)
		expectHex(t, "gcm", out, "00"+c.want)

		// streamed byte by byte
		init := mustBytes(t, ctx, CipherInit, "aes-128-gcm", c.key, c.iv, false, nil, true, c.aad)
		h := handleOf(t, init)
		var streamed []byte
		for i := range c.plaintext {
			streamed = append(streamed, mustBytes(t, ctx, CipherUpdate, h, c.plaintext[i:i+1])...)
		}
		streamed = append(streamed, mustBytes(t, ctx, CipherFinal, h)...)
		expectHex(t, "gcm streamed", streamed, c.want)

		want := unhex(c.want)
		ciphertext, tag := want[:len(c.plaintext)], want[len(c.plaintext):]
		out = mustBytes(t, ctx, Aead, "aes-128-gcm", c.key, c.iv, true, nil, c.aad, tag, ciphertext)
		if out[0] != 1 || !bytes.Equal(out[1:], c.plaintext) {
			t.Fatalf("gcm decrypt %x", out)
		}
		// a truncated tag verifies on its prefix
		out = mustBytes(t, ctx, Aead, "aes-128-gcm", c.key, c.iv, true, 8, c.aad, tag[:8], ciphertext)
		if out[0] != 1 {
			t.Fatalf("gcm truncated tag status %d", out[0])
		}
	}

	// a 4-byte tag, Node's shortest
	out := mustBytes(t, ctx, Aead, "aes-128-gcm", fill(16, 1), fill(12, 2), false, 4, []byte("aad"), nil, fill(40, 3))
	expectHex(t, "gcm 4-byte tag", out, "00"+nodeVectors["gcm4.ct"]+nodeVectors["gcm4.tag"])
}

// A 16-byte IV whose first counter block ends in ffffff59: the 32-bit
// counter wraps after 167 blocks (Wycheproof's "wrapped counter" case).
// Node's ciphertext SHA-256 and tag.
func TestGCMCounterWrapNode(t *testing.T) {
	ctx := newTestContext()
	key, iv, plaintext := fill(16, 1), unhex("0000000000000000000000000039869f"), fill(4000, 3)
	const wantSum, wantTag = "1238eb78cac08c884c5360093a1dcb3f2b4ef006fab3339a41da534d4272a62a", "0e47de150237124f0b4507ef868cf801"

	out := mustBytes(t, ctx, Aead, "aes-128-gcm", key, iv, false, nil, []byte("aad"), nil, plaintext)
	ciphertext, tag := out[1:1+len(plaintext)], out[1+len(plaintext):]
	expectHex(t, "wrap ciphertext", mustBytes(t, ctx, Hash, "sha256", nil, ciphertext), wantSum)
	expectHex(t, "wrap tag", tag, wantTag)

	h := handleOf(t, mustBytes(t, ctx, CipherInit, "aes-128-gcm", key, iv, true, nil, true, []byte("aad"), tag))
	var decrypted []byte
	for offset := 0; offset < len(ciphertext); offset += 999 {
		decrypted = append(decrypted, mustBytes(t, ctx, CipherUpdate, h, ciphertext[offset:min(offset+999, len(ciphertext))])...)
	}
	mustCall(t, ctx, CipherFinal, h)
	if !bytes.Equal(decrypted, plaintext) {
		t.Fatal("wrap decrypt")
	}
}

// the 32-bit GCM counter wraps without carrying into the IV part
func TestGCMCounterWrap(t *testing.T) {
	block, _ := aes.NewCipher(make([]byte, 16))
	g := &gcmStream{block: block}
	copy(g.counter[:], unhex("000102030405060708090a0bfffffffe"))
	g.segment()

	data := make([]byte, 16*4+5)
	out := make([]byte, len(data))
	g.XORKeyStream(out[:7], data[:7])
	g.XORKeyStream(out[7:], data[7:])

	counter := unhex("000102030405060708090a0bfffffffe")
	want := make([]byte, 0, 80)
	ks := make([]byte, 16)
	for len(want) < len(data) {
		block.Encrypt(ks, counter)
		want = append(want, ks...)
		binary.BigEndian.PutUint32(counter[12:], binary.BigEndian.Uint32(counter[12:])+1)
	}
	if !bytes.Equal(out, want[:len(data)]) {
		t.Fatalf("wrap:\n got %x\nwant %x", out, want[:len(data)])
	}
}

// RFC 8439 2.8.2
func TestChaCha20Poly1305(t *testing.T) {
	ctx := newTestContext()
	key := unhex("808182838485868788898a8b8c8d8e8f909192939495969798999a9b9c9d9e9f")
	nonce := unhex("070000004041424344454647")
	aad := unhex("50515253c0c1c2c3c4c5c6c7")
	plaintext := []byte("Ladies and Gentlemen of the class of '99: If I could offer you only one tip for the future, sunscreen would be it.")
	out := mustBytes(t, ctx, Aead, "chacha20-poly1305", key, nonce, false, nil, aad, nil, plaintext)
	expectHex(t, "chacha20-poly1305", out[1:], "d31a8d34648e60db7b86afbc53ef7ec2a4aded51296e08fea9e2b5a736ee62d63dbea45e8ca9671282fafb69da92728b1a71de0a9e060b2905d6a5b67ecd3b3692ddbd7f2d778b8c9803aee328091b58fab324e4fad675945585808b4831d7bc3ff4def08e4b7a9de576d26586cec64b6116"+
		"1ae10b594f09e26a7e902ecbd0600691")
}

// OpenSSL's chacha20 carries the 32-bit counter into the nonce
func TestChaCha20Carry(t *testing.T) {
	ctx := newTestContext()
	out := mustBytes(t, ctx, CipherInit, "chacha20", fill(32, 1), unhex(nodeVectors["chacha20.carry.iv"]), false, nil, true, nil, nil, make([]byte, 100))
	more := mustBytes(t, ctx, CipherUpdate, handleOf(t, out), make([]byte, 100))
	expectHex(t, "carry", append(out[4:], more...), nodeVectors["chacha20.carry"])
}

func TestCipherErrors(t *testing.T) {
	ctx := newTestContext()
	k16, k32 := make([]byte, 16), make([]byte, 32)

	_, err := call(ctx, CipherInit, "aes-128-foo", k16, k16, false)
	expectError(t, err, "Error|ERR_CRYPTO_UNKNOWN_CIPHER")
	_, err = call(ctx, CipherInit, "aes-128-cbc", k32, k16, false)
	expectError(t, err, "RangeError|ERR_CRYPTO_INVALID_KEYLEN")
	_, err = call(ctx, CipherInit, "aes-128-cbc", k16, k32, false)
	expectError(t, err, "TypeError|ERR_CRYPTO_INVALID_IV")
	_, err = call(ctx, CipherInit, "aes-128-ecb", k16, k16, false)
	expectError(t, err, "TypeError|ERR_CRYPTO_INVALID_IV")
	_, err = call(ctx, CipherInit, "aes-128-gcm", k16, []byte{}, false)
	expectError(t, err, "TypeError|ERR_CRYPTO_INVALID_IV")
	_, err = call(ctx, CipherInit, "aes-128-gcm", k16, make([]byte, 129), false)
	expectError(t, err, "TypeError|ERR_CRYPTO_INVALID_IV")
	_, err = call(ctx, CipherInit, "chacha20-poly1305", k32, make([]byte, 8), false)
	expectError(t, err, "TypeError|ERR_CRYPTO_INVALID_IV")
	_, err = call(ctx, CipherInit, "chacha20", k32, make([]byte, 12), false)
	expectError(t, err, "TypeError|ERR_CRYPTO_INVALID_IV")
	_, err = call(ctx, CipherInit, "aes-128-gcm", k16, make([]byte, 12), false, 5)
	expectError(t, err, "TypeError|ERR_CRYPTO_INVALID_AUTH_TAG")
	_, err = call(ctx, CipherInit, "chacha20-poly1305", k32, make([]byte, 12), false, 17)
	expectError(t, err, "TypeError|ERR_CRYPTO_INVALID_AUTH_TAG")
	_, err = call(ctx, Aead, "aes-128-gcm", k16, make([]byte, 12), true, nil, nil, make([]byte, 5), []byte("x"))
	expectError(t, err, "TypeError|ERR_CRYPTO_INVALID_AUTH_TAG")
	_, err = call(ctx, Aead, "chacha20-poly1305", k32, make([]byte, 12), true, nil, nil, make([]byte, 8), []byte("x"))
	expectError(t, err, "TypeError|ERR_CRYPTO_INVALID_AUTH_TAG")
	_, err = call(ctx, Aead, "aes-128-gcm", k16, make([]byte, 12), true, 12, nil, make([]byte, 16), []byte("x"))
	expectError(t, err, "TypeError|ERR_CRYPTO_INVALID_AUTH_TAG")
	_, err = call(ctx, Aead, "aes-128-cbc", k16, k16, false, nil, nil, nil, []byte("x"))
	expectError(t, err, "Error|ERR_CRYPTO_UNKNOWN_CIPHER")

	final := func(algorithm string, iv []byte, decrypt, padding bool, data []byte) error {
		out := mustBytes(t, ctx, CipherInit, algorithm, k16, iv, decrypt, nil, padding, nil, nil, data)
		_, err := call(ctx, CipherFinal, handleOf(t, out))
		return err
	}
	expectError(t, final("aes-128-cbc", k16, true, true, make([]byte, 16)), "Error|ERR_OSSL_BAD_DECRYPT")
	expectError(t, final("aes-128-cbc", k16, true, true, make([]byte, 15)), "Error|ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH")
	expectError(t, final("aes-128-cbc", k16, true, true, nil), "Error|ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH")
	expectError(t, final("aes-128-ecb", nil, false, false, make([]byte, 15)), "Error|ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH")
	expectError(t, final("aes-128-cbc", k16, true, false, make([]byte, 17)), "Error|ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH")
	expectError(t, final("aes-128-gcm", k16[:12], true, true, []byte("abc")), "Error|")

	// the handle is gone after a failed final too
	if len(ctx.Crypto) != 0 {
		t.Fatalf("handles left: %d", len(ctx.Crypto))
	}

	// padding switched off after init
	out := mustBytes(t, ctx, CipherInit, "aes-128-cbc", k16, k16, false, nil, true)
	h := handleOf(t, out)
	mustCall(t, ctx, CipherSetAutoPadding, h, false)
	if got := mustBytes(t, ctx, CipherUpdate, h, make([]byte, 16)); len(got) != 16 {
		t.Fatalf("update %x", got)
	}
	if got := mustBytes(t, ctx, CipherFinal, h); len(got) != 0 {
		t.Fatalf("final %x", got)
	}
}
