package tunnel

import (
	"encoding/binary"
	"errors"
)

// A tunnel WebSocket is a multiplexed session: every binary message is one
// frame, [type u8][stream id u32 BE][payload]. The runtime opens streams (it
// picks the ids, never reused within a session); the hub dials the tunnel's
// target for each stream and answers OPENED, or RESET with a reason. Spec:
// fullstackedorg/tunnels docs/1-concepts/protocol-spec.md.
const (
	frameOpen   byte = 1 // open a stream
	frameOpened byte = 2 // the target is dialed
	frameData   byte = 3 // stream bytes
	frameWindow byte = 4 // payload u32 BE: bytes the peer may send more
	frameFin    byte = 5 // no more data from this side
	frameReset  byte = 6 // abort the stream; payload: reason

	frameHeaderSize = 5

	// initial send credit of a stream in each direction, renewed by WINDOW
	streamWindow = 256 * 1024
	// largest DATA payload: big writes go out in several frames so streams
	// interleave on the session
	maxDataPayload = 32 * 1024
)

var errBadFrame = errors.New("tunnel: malformed mux frame")

func encodeFrame(typ byte, id uint32, payload []byte) []byte {
	frame := make([]byte, frameHeaderSize+len(payload))
	frame[0] = typ
	binary.BigEndian.PutUint32(frame[1:], id)
	copy(frame[frameHeaderSize:], payload)
	return frame
}

func encodeWindow(id uint32, increment uint32) []byte {
	var payload [4]byte
	binary.BigEndian.PutUint32(payload[:], increment)
	return encodeFrame(frameWindow, id, payload[:])
}

func decodeFrame(message []byte) (typ byte, id uint32, payload []byte, err error) {
	if len(message) < frameHeaderSize || message[0] < frameOpen || message[0] > frameReset {
		return 0, 0, nil, errBadFrame
	}
	return message[0], binary.BigEndian.Uint32(message[1:]), message[frameHeaderSize:], nil
}
