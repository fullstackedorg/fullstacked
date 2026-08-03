package fetch

import (
	"fullstackedorg/fullstacked/types"
	"sync"
	"testing"
)

func TestConcurrentResponseBodyCheck(t *testing.T) {
	var wg sync.WaitGroup

	// Concurrently invoke ResponseBody case, closeFetchResponse, and safelyGetResponse
	for i := 0; i < 100; i++ {
		wg.Add(3)

		go func(id int) {
			defer wg.Done()
			var res types.CoreCallResponse
			header := types.CoreCallHeader{
				Fn: ResponseBody,
			}
			data := []types.DeserializedData{
				{Data: float64(id)},
			}
			_ = Switch(nil, header, data, &res)
		}(i)

		go func(id int) {
			defer wg.Done()
			closeFetchResponse(id)
		}(i)

		go func(id int) {
			defer wg.Done()
			_ = safelyGetResponse(id)
		}(i)
	}

	wg.Wait()
}
