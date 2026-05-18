package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"
)

func TestCompressAndRestoreExecutable(t *testing.T) {
	originalAppsRoot := appsRoot
	appsRoot = t.TempDir()
	t.Cleanup(func() {
		appsRoot = originalAppsRoot
	})

	meta := metadata{
		App:     "demo",
		Release: "abc123",
		Kind:    "executable",
		Type:    "node",
	}
	root := releaseRoot(meta)
	if err := os.MkdirAll(root, 0755); err != nil {
		t.Fatal(err)
	}
	content := bytes.Repeat([]byte("node-sea-binary\x00"), 1024)
	if err := os.WriteFile(executablePath(meta), content, 0755); err != nil {
		t.Fatal(err)
	}

	if err := compressExecutable(meta); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(executablePath(meta)); !os.IsNotExist(err) {
		t.Fatalf("expected executable to be removed after compression, got %v", err)
	}
	if _, err := os.Stat(compressedExecutablePath(meta)); err != nil {
		t.Fatalf("expected compressed executable: %v", err)
	}

	if err := restoreCompressedExecutable(meta); err != nil {
		t.Fatal(err)
	}
	restored, err := os.ReadFile(executablePath(meta))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(restored, content) {
		t.Fatal("restored executable content mismatch")
	}
	info, err := os.Stat(executablePath(meta))
	if err != nil {
		t.Fatal(err)
	}
	if info.Mode().Perm() != 0755 {
		t.Fatalf("restored executable mode = %v, want 0755", info.Mode().Perm())
	}
}

func TestCompressInactiveExecutableSkipsCurrentRelease(t *testing.T) {
	originalAppsRoot := appsRoot
	appsRoot = t.TempDir()
	t.Cleanup(func() {
		appsRoot = originalAppsRoot
	})

	meta := metadata{
		App:     "demo",
		Release: "abc123",
		Kind:    "executable",
		Type:    "bun",
	}
	root := releaseRoot(meta)
	if err := os.MkdirAll(root, 0755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(executablePath(meta), []byte("binary"), 0755); err != nil {
		t.Fatal(err)
	}

	supervisor := &supervisor{currentByApp: map[string]string{"demo": "abc123"}}
	if err := supervisor.compressInactiveExecutable(meta); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(root, "app")); err != nil {
		t.Fatalf("current release app should remain uncompressed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(root, "app.gz")); !os.IsNotExist(err) {
		t.Fatalf("current release should not have app.gz, got %v", err)
	}
}

func TestCompressInactiveExecutableReusesExistingCompressedCopy(t *testing.T) {
	originalAppsRoot := appsRoot
	appsRoot = t.TempDir()
	t.Cleanup(func() {
		appsRoot = originalAppsRoot
	})

	meta := metadata{
		App:     "demo",
		Release: "abc123",
		Kind:    "executable",
		Type:    "deno",
	}
	root := releaseRoot(meta)
	if err := os.MkdirAll(root, 0755); err != nil {
		t.Fatal(err)
	}
	content := bytes.Repeat([]byte("deno-binary\x00"), 1024)
	if err := os.WriteFile(executablePath(meta), content, 0755); err != nil {
		t.Fatal(err)
	}
	if err := compressExecutable(meta); err != nil {
		t.Fatal(err)
	}
	compressedBefore, err := os.ReadFile(compressedExecutablePath(meta))
	if err != nil {
		t.Fatal(err)
	}

	if err := restoreCompressedExecutable(meta); err != nil {
		t.Fatal(err)
	}
	supervisor := &supervisor{currentByApp: map[string]string{}}
	if err := supervisor.compressInactiveExecutable(meta); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(executablePath(meta)); !os.IsNotExist(err) {
		t.Fatalf("restored executable should be deleted after inactive stop, got %v", err)
	}
	compressedAfter, err := os.ReadFile(compressedExecutablePath(meta))
	if err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(compressedAfter, compressedBefore) {
		t.Fatal("compressed executable should be reused, not rewritten")
	}
}
