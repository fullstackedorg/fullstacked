// Package crypto runs the work of Node's crypto module the JS side cannot do
// fast or at all: ciphers, keys, signatures, key agreement and KDFs. Stateful
// objects (hashes, ciphers) are handles kept in the context, see handles.go.
// Errors are "<Class>|<code>|<message>" strings the JS side turns back into
// Node errors, see errors.go.
package crypto

import (
	"encoding/json"
	"fullstackedorg/fullstacked/types"
)

type CryptoFn = uint8

const (
	Hash                 CryptoFn = 0
	HashCreate           CryptoFn = 1
	HashUpdate           CryptoFn = 2
	HashDigest           CryptoFn = 3
	HashCopy             CryptoFn = 4
	Free                 CryptoFn = 5
	CipherInit           CryptoFn = 6
	CipherUpdate         CryptoFn = 7
	CipherFinal          CryptoFn = 8
	CipherSetAutoPadding CryptoFn = 9
	Aead                 CryptoFn = 10
	KeyParse             CryptoFn = 11
	KeyExport            CryptoFn = 12
	KeyGenerate          CryptoFn = 13
	Sign                 CryptoFn = 14
	Verify               CryptoFn = 15
	DiffieHellman        CryptoFn = 16
	DhGroup              CryptoFn = 17
	DhGenerate           CryptoFn = 18
	DhCompute            CryptoFn = 19
	EcdhGenerate         CryptoFn = 20
	EcdhCompute          CryptoFn = 21
	EcdhConvertKey       CryptoFn = 22
	Pbkdf2               CryptoFn = 23
	Scrypt               CryptoFn = 24
	Hkdf                 CryptoFn = 25
	RsaCrypt             CryptoFn = 26
)

type fnImpl = func(ctx *types.Context, a args) (any, error)

var fns = map[CryptoFn]fnImpl{
	Hash:                 hashOneShot,
	HashCreate:           hashCreate,
	HashUpdate:           hashUpdate,
	HashDigest:           hashDigest,
	HashCopy:             hashCopy,
	Free:                 freeHandle,
	CipherInit:           cipherInit,
	CipherUpdate:         cipherUpdate,
	CipherFinal:          cipherFinal,
	CipherSetAutoPadding: cipherSetAutoPadding,
	Aead:                 aeadOneShot,
	KeyParse:             keyParse,
	KeyExport:            keyExport,
	KeyGenerate:          keyGenerate,
	Sign:                 sign,
	Verify:               verify,
	DiffieHellman:        diffieHellman,
	DhGroup:              dhGroup,
	DhGenerate:           dhGenerate,
	DhCompute:            dhCompute,
	EcdhGenerate:         ecdhGenerate,
	EcdhCompute:          ecdhCompute,
	EcdhConvertKey:       ecdhConvertKey,
	Pbkdf2:               pbkdf2Fn,
	Scrypt:               scryptFn,
	Hkdf:                 hkdfFn,
	RsaCrypt:             rsaCrypt,
}

func Switch(
	ctx *types.Context,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) (err error) {
	fn, ok := fns[header.Fn]
	if !ok {
		return newError("", "unknown crypto function")
	}

	// a malformed call (wrong argument types) must not take the core down
	defer func() {
		if r := recover(); r != nil {
			err = newError("ERR_CRYPTO_OPERATION_FAILED", "crypto operation failed")
		}
	}()

	result, err := fn(ctx, args(data))
	if err != nil {
		return err
	}

	response.Type = types.CoreResponseData
	response.Data = result
	return nil
}

// args are the positional call arguments. Optional ones come as undefined
// and trailing ones may be missing, every getter treats both the same.
type args []types.DeserializedData

func (a args) defined(i int) bool {
	return i < len(a) && a[i].Type != types.UNDEFINED
}

func (a args) str(i int) string {
	if i < len(a) && a[i].Type == types.STRING {
		return a[i].Data.(string)
	}
	return ""
}

// buf reads a buffer argument, a string is taken as its UTF-8 bytes. The
// bytes alias the call payload: copy them before keeping them in a handle.
func (a args) buf(i int) []byte {
	if i >= len(a) {
		return nil
	}
	switch a[i].Type {
	case types.BUFFER:
		return a[i].Data.([]byte)
	case types.STRING:
		return []byte(a[i].Data.(string))
	}
	return nil
}

func (a args) num(i int, fallback float64) float64 {
	if i < len(a) && a[i].Type == types.NUMBER {
		return a[i].Data.(float64)
	}
	return fallback
}

func (a args) int(i int, fallback int) int {
	return int(a.num(i, float64(fallback)))
}

func (a args) bool(i int) bool {
	return i < len(a) && a[i].Type == types.BOOLEAN && a[i].Data.(bool)
}

// object unmarshals an object argument, a JSON string works the same
func (a args) object(i int, v any) error {
	if i >= len(a) {
		return nil
	}
	switch a[i].Type {
	case types.OBJECT:
		return json.Unmarshal(a[i].Data.(types.DeserializedRawObject).Data, v)
	case types.STRING:
		return json.Unmarshal([]byte(a[i].Data.(string)), v)
	case types.BUFFER:
		return json.Unmarshal(a[i].Data.([]byte), v)
	}
	return nil
}

func clone(b []byte) []byte {
	return append([]byte(nil), b...)
}
