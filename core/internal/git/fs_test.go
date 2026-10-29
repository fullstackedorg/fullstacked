package git

import (
	"bytes"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func TestCustomFS_Basic(t *testing.T) {
	tmpDir, err := os.MkdirTemp("", "customfs-test")
	if err != nil {
		t.Fatalf("failed to create temp dir: %v", err)
	}
	defer os.RemoveAll(tmpDir)

	fsys := NewCustomFS(tmpDir)

	// Test MkdirAll
	err = fsys.MkdirAll("sub/dir", 0755)
	if err != nil {
		t.Fatalf("MkdirAll failed: %v", err)
	}

	// Test Create
	f, err := fsys.Create("sub/dir/test.txt")
	if err != nil {
		t.Fatalf("Create failed: %v", err)
	}

	// Test Write
	data := []byte("hello world")
	n, err := f.Write(data)
	if err != nil || n != len(data) {
		t.Fatalf("Write failed: n=%d, err=%v", n, err)
	}
	f.Close()

	// Test Open
	f, err = fsys.Open("sub/dir/test.txt")
	if err != nil {
		t.Fatalf("Open failed: %v", err)
	}

	// Test Read
	readBuf := make([]byte, len(data))
	n, err = f.Read(readBuf)
	if err != nil && err != io.EOF {
		t.Fatalf("Read failed: %v", err)
	}
	if !bytes.Equal(readBuf, data) {
		t.Fatalf("read data mismatch: got %q, want %q", readBuf, data)
	}
	f.Close()

	// Test Stat
	fi, err := fsys.Stat("sub/dir/test.txt")
	if err != nil {
		t.Fatalf("Stat failed: %v", err)
	}
	if fi.Name() != "test.txt" {
		t.Errorf("Stat name mismatch: got %q, want %q", fi.Name(), "test.txt")
	}

	// Test ReadDir
	entries, err := fsys.ReadDir("sub/dir")
	if err != nil {
		t.Fatalf("ReadDir failed: %v", err)
	}
	if len(entries) != 1 || entries[0].Name() != "test.txt" {
		t.Errorf("ReadDir entries mismatch: %v", entries)
	}

	// Test TempFile
	tmpF, err := fsys.TempFile("sub", "prefix-")
	if err != nil {
		t.Fatalf("TempFile failed: %v", err)
	}
	tmpF.Close()
	defer fsys.Remove(tmpF.Name())

	if !filepath.HasPrefix(filepath.Base(tmpF.Name()), "prefix-") {
		t.Errorf("TempFile prefix mismatch: %s", tmpF.Name())
	}
}
