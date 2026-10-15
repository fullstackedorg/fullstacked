package crypto

import "strconv"

// nodeError travels to the JS side as "<Class>|<code>|<message>", the
// class and code being what Node throws for the same failure (code may be
// empty, Node has none for a few OpenSSL errors)
type nodeError struct {
	class   string
	code    string
	message string
}

func (e *nodeError) Error() string {
	return e.class + "|" + e.code + "|" + e.message
}

func newError(code, message string) error {
	return &nodeError{"Error", code, message}
}

func newTypeError(code, message string) error {
	return &nodeError{"TypeError", code, message}
}

func newRangeError(code, message string) error {
	return &nodeError{"RangeError", code, message}
}

// Node's OpenSSL errors, with the message OpenSSL 3 gives
var (
	errBadDecrypt          = newError("ERR_OSSL_BAD_DECRYPT", "error:1C800064:Provider routines::bad decrypt")
	errWrongFinalBlock     = newError("ERR_OSSL_WRONG_FINAL_BLOCK_LENGTH", "error:1C80006B:Provider routines::wrong final block length")
	errAuthFailed          = newError("", "Unsupported state or unable to authenticate data")
	errInvalidKeyLength    = newRangeError("ERR_CRYPTO_INVALID_KEYLEN", "Invalid key length")
	errInvalidIV           = newTypeError("ERR_CRYPTO_INVALID_IV", "Invalid initialization vector")
	errUnknownCipher       = newError("ERR_CRYPTO_UNKNOWN_CIPHER", "Unknown cipher")
	errDigestNotSupported  = newError("", "Digest method not supported")
	errNotXOF              = newError("ERR_OSSL_EVP_NOT_XOF_OR_INVALID_LENGTH", "error:030000B2:digital envelope routines::not XOF or invalid length")
	errHmacXOF             = newError("", "error:00000000:lib(0)::reason(0)")
	errDerivingBits        = newError("", "Deriving bits failed")
	errInvalidCurve        = newTypeError("ERR_CRYPTO_INVALID_CURVE", "Invalid EC curve name")
	errInvalidPublicPoint  = newError("ERR_CRYPTO_ECDH_INVALID_PUBLIC_KEY", "Public key is not valid for specified curve")
	errInvalidPrivateEcdh  = newRangeError("ERR_CRYPTO_INVALID_KEYTYPE", "Private key is not valid for specified curve.")
	errDecoderUnsupported  = newError("ERR_OSSL_UNSUPPORTED", "error:1E08010C:DECODER routines::unsupported")
	errPemNoPassphrase     = newError("ERR_OSSL_CRYPTO_INTERRUPTED_OR_CANCELLED", "error:07880109:common libcrypto routines::interrupted or cancelled")
	errDerNoPassphrase     = newTypeError("ERR_MISSING_PASSPHRASE", "Passphrase required for encrypted key")
	errNotForKeyType       = newError("ERR_OSSL_EVP_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE", "error:03000096:digital envelope routines::operation not supported for this keytype")
	errProviderNotForKey   = newError("ERR_OSSL_OPERATION_NOT_SUPPORTED_FOR_THIS_KEYTYPE", "error:1C8000B2:Provider routines::operation not supported for this keytype")
	errInvalidDigestForKey = newError("ERR_OSSL_INVALID_DIGEST", "error:1C80007A:Provider routines::invalid digest")
	errDigestNotAllowed    = newError("ERR_OSSL_DIGEST_NOT_ALLOWED", "error:1C8000AE:Provider routines::digest not allowed")
	errInvalidPaddingMode  = newError("ERR_OSSL_INVALID_PADDING_MODE", "error:1C8000A8:Provider routines::invalid padding mode")
	errIllegalPadding      = newError("ERR_OSSL_ILLEGAL_OR_UNSUPPORTED_PADDING_MODE", "error:1C8000A5:Provider routines::illegal or unsupported padding mode")
	errPssSaltTooSmall     = newError("ERR_OSSL_PSS_SALTLEN_TOO_SMALL", "error:1C8000AC:Provider routines::pss saltlen too small")
	errTooLargeForKey      = newError("ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_KEY_SIZE", "error:0200006E:rsa routines::data too large for key size")
	errTooSmallForKey      = newError("ERR_OSSL_RSA_DATA_TOO_SMALL_FOR_KEY_SIZE", "error:0200007A:rsa routines::data too small for key size")
	errTooLargeForModulus  = newError("ERR_OSSL_RSA_DATA_TOO_LARGE_FOR_MODULUS", "error:02000084:rsa routines::data too large for modulus")
	errOaepDecoding        = newError("ERR_OSSL_RSA_OAEP_DECODING_ERROR", "error:02000079:rsa routines::oaep decoding error")
	errRsaInvalidPadding   = newError("ERR_OSSL_RSA_INVALID_PADDING", "error:0200008A:rsa routines::invalid padding")
	errInvalidOaepDigest   = newError("ERR_OSSL_EVP_INVALID_DIGEST", "Invalid digest used")
	errMismatchingDomain   = newError("ERR_OSSL_MISMATCHING_DOMAIN_PARAMETERS", "error:1C8000CB:Provider routines::mismatching domain parameters")
	errDerivationFailed    = newError("ERR_OSSL_FAILED_DURING_DERIVATION", "error:1C8000A4:Provider routines::failed during derivation")
	errDhKeyTooSmall       = newRangeError("ERR_CRYPTO_INVALID_KEYLEN", "Supplied key is too small")
	errDhKeyTooLarge       = newRangeError("ERR_CRYPTO_INVALID_KEYLEN", "Supplied key is too large")
	errDhBadGenerator      = newError("ERR_OSSL_DH_BAD_GENERATOR", "error:02800065:Diffie-Hellman routines::bad generator")
	errUnknownDhGroup      = newError("ERR_CRYPTO_UNKNOWN_DH_GROUP", "Unknown DH group")
	errScryptParams        = newRangeError("ERR_CRYPTO_INVALID_SCRYPT_PARAMS", "Invalid scrypt params: error:030000AC:digital envelope routines::memory limit exceeded")
	errRsaKeyTooSmall      = newError("", "error:1C8000AB:Provider routines::key size too small")
	errRsaBadExponent      = newError("", "error:020000B2:rsa routines::pub exponent out of range")
	errJwkUnsupportedType  = newError("ERR_CRYPTO_JWK_UNSUPPORTED_KEY_TYPE", "Unsupported JWK Key Type.")
	errInvalidHandle       = newError("ERR_CRYPTO_INVALID_STATE", "Invalid crypto handle")
	errTooManyHandles      = newError("ERR_CRYPTO_OPERATION_FAILED", "too many crypto handles")
	errContextEnded        = newError("ERR_CRYPTO_OPERATION_FAILED", "context ended")
)

func errInvalidDigest(name string) error {
	return newTypeError("ERR_CRYPTO_INVALID_DIGEST", "Invalid digest: "+name)
}

func errInvalidAuthTag(length int) error {
	return newTypeError("ERR_CRYPTO_INVALID_AUTH_TAG", "Invalid authentication tag length: "+strconv.Itoa(length))
}

func errIncompatibleKeyOptions(encoding, keyType string) error {
	return newError("ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS", "The selected key encoding "+encoding+" can only be used for "+keyType+" keys.")
}

func errEncryptionNotSupported(encoding string) error {
	return newError("ERR_CRYPTO_INCOMPATIBLE_KEY_OPTIONS", "The selected key encoding "+encoding+" does not support encryption.")
}

func errInvalidJwk(what string) error {
	return newTypeError("ERR_CRYPTO_INVALID_JWK", "Invalid JWK "+what)
}

func errJwkProperty(name string) error {
	return newTypeError("ERR_INVALID_ARG_TYPE", "The \"key."+name+"\" property must be of type string. Received undefined")
}
