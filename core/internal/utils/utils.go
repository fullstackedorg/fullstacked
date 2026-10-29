package utils

import (
	"crypto/rand"
)

// RandomAlpha returns a random lowercase alphabetic string of the specified length.
func RandomAlpha(length int) (string, error) {
	const letters = "abcdefghijklmnopqrstuvwxyz"
	bytes := make([]byte, length)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	for i, b := range bytes {
		bytes[i] = letters[b%26]
	}
	return string(bytes), nil
}
