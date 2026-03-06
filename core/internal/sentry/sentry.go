package sentry

import (
	"errors"
	"fullstackedorg/fullstacked/internal/store"
	"fullstackedorg/fullstacked/types"

	sentryLib "github.com/getsentry/sentry-go"
)

type SentryFn = uint8

const (
	Init SentryFn = 0
)

func Switch(ctx *types.Context,
	header types.CoreCallHeader,
	data []types.DeserializedData,
	response *types.CoreCallResponse,
) error {
	switch header.Fn {
	case Init:
		response.Type = types.CoreResponseData

		sentryLib.Init(sentryLib.ClientOptions{
			Dsn:         data[0].Data.(string),
			Release:     data[1].Data.(string),
			Environment: data[2].Data.(string),
		})

		store.HasSentry = true

		return nil
	}

	return errors.New("unkown sentry function")
}
