package utils

import (
	"math/rand"
	"net/http"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

var letterRunes = []rune("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ")

func RandString(n int) string {
	b := make([]rune, n)
	for i := range b {
		b[i] = letterRunes[rand.Intn(len(letterRunes))]
	}
	return string(b)
}

// source: https://stackoverflow.com/a/77944299
func NewDebouncer(dur time.Duration) func(fn func()) {
	d := &debouncer{
		dur: dur,
	}

	return func(fn func()) {
		d.reset(fn)
	}
}

type debouncer struct {
	mu    sync.Mutex
	dur   time.Duration
	delay *time.Timer
}

func (d *debouncer) reset(fn func()) {
	d.mu.Lock()
	defer d.mu.Unlock()

	if d.delay != nil {
		d.delay.Stop()
	}

	d.delay = time.AfterFunc(d.dur, fn)
}

func IsReacheable(url string) bool {
	client := &http.Client{
		CheckRedirect: func(req *http.Request, via []*http.Request) error {
			return http.ErrUseLastResponse
		},
		Timeout: time.Second * 3,
	}

	_, err := client.Head(url)

	return err == nil
}

func RemoveDriveLetter(p string) string {
	volume := filepath.VolumeName(p)
	if volume != "" {
		return strings.TrimPrefix(p, volume)
	}
	return p
}