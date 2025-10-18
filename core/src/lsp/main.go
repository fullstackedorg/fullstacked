package ts_lsp

import (
	"errors"
	"fmt"
	"fullstackedorg/fullstacked/core/src/fs"
	"fullstackedorg/fullstacked/core/src/setup"
	"fullstackedorg/fullstacked/core/src/utils"
	"io"
	"slices"
	"strconv"

	tsgo "github.com/microsoft/typescript-go/cmd/module"
)

var startToken = "Content-Length: "
var startTokenBin = []byte(startToken)
var headerSplit = "\r\n\r\n"
var headerSplitBin = []byte(headerSplit)

func findOccurence(buffer []byte, matching []byte, num int) int {
	count := 0
	for i := range buffer {
		fullMatch := true
		for j, m := range matching {
			if i+j > len(buffer)-1 || m != buffer[i+j] {
				fullMatch = false
				break
			}
		}
		if fullMatch {
			count += 1
		}
		if count == num {
			return i
		}
	}

	return -1
}

type BufferSlice struct {
	From int
	To   int
}

func processBuffer(buffer []byte) (*BufferSlice, error) {
	if len(buffer) < len(startTokenBin) {
		return nil, nil
	}

	if !slices.Equal(buffer[0:len(startTokenBin)], startTokenBin) {
		return nil, errors.New("buffer does not contain start token")
	}

	posHeaderSplit := findOccurence(buffer, headerSplitBin, 1)

	numStr := buffer[len(startTokenBin):posHeaderSplit]
	expectedLength, err := strconv.Atoi(string(numStr))

	if err != nil {
		return nil, err
	}

	posStartMessage := posHeaderSplit + len(headerSplit)

	messageBuffer := buffer[posStartMessage:]

	if len(messageBuffer) < expectedLength {
		return nil, nil
	}

	return &BufferSlice{
		From: posStartMessage,
		To:   posStartMessage + expectedLength,
	}, nil
}

type LspInstance struct {
	PipeWriter *io.PipeWriter
}

var LSPs = make(map[string]*LspInstance)

func Start(directory string) string {
	transportId := utils.RandString(6)

	end := make(chan struct{})

	callbackMessageType := "lsp-" + transportId

	inRead, inWrite := io.Pipe()
	outRead, outWrite := io.Pipe()

	LSPs[transportId] = &LspInstance{
		PipeWriter: inWrite,
	}

	fmt.Println("STARTING ", transportId)

	if fs.WASM {
		go tsgo.RunLSP_WASM(
			&WasmFS{},
			directory,
			inRead,
			outWrite,
			end,
		)
	} else {
		go tsgo.RunLSP(
			directory,
			inRead,
			outWrite,
			end,
		)
	}

	buffer := []byte{}

	go func() {
		for {
			select {
			case <-end:
				fmt.Println("CLOSING ", transportId)
				setup.Callback("", "lsp-close", transportId)
				return
			default:
				b := make([]byte, 1024)
				n, _ := outRead.Read(b)

				if n > 0 {
					buffer = append(buffer, b[0:n]...)
					bSlice, err := processBuffer(buffer)
					if err != nil {
						panic(err)
					}
					if bSlice != nil {
						message := string(buffer[bSlice.From:bSlice.To])
						setup.Callback("", callbackMessageType, message)
						buffer = buffer[bSlice.To:]
					}
				}
			}
		}
	}()

	return transportId
}

func Request(transportId string, message string) {
	lspInstance, ok := LSPs[transportId]

	if !ok {
		fmt.Println("could not find lsp for " + transportId)
		return
	}

	messageData := []byte(message)
	contentLength := len(messageData)
	payload := startToken + strconv.Itoa(contentLength) + headerSplit + message
	lspInstance.PipeWriter.Write([]byte(payload))
}

func End(transportId string) {
	lspInstance, ok := LSPs[transportId]

	if !ok {
		return
	}

	lspInstance.PipeWriter.Close()
	delete(LSPs, transportId)
}

func Version() string {
	return tsgo.Version()
}
