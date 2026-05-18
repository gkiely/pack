package main

import (
	"bytes"
	"encoding/json"
	"fmt"
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

func TestScanMetadataRejectsStaticRootOutsideReleaseTree(t *testing.T) {
	originalAppsRoot := appsRoot
	appsRoot = t.TempDir()
	t.Cleanup(func() {
		appsRoot = originalAppsRoot
	})

	meta := metadata{
		App:       "demo",
		Release:   "abc123",
		Kind:      "static",
		Root:      t.TempDir(),
		CreatedAt: "2026-05-18T00:00:00Z",
	}
	releaseDir := filepath.Join(appsRoot, "demo", "releases", "abc123")
	if err := os.MkdirAll(releaseDir, 0755); err != nil {
		t.Fatal(err)
	}
	writeMetadata(t, releaseDir, meta)

	releases, _, err := scanMetadata()
	if err != nil {
		t.Fatal(err)
	}
	if _, ok := releases["abc123"]; ok {
		t.Fatal("metadata with static root outside release tree should be rejected")
	}
}

func TestScanMetadataNormalizesTrustedPathFields(t *testing.T) {
	originalAppsRoot := appsRoot
	appsRoot = t.TempDir()
	t.Cleanup(func() {
		appsRoot = originalAppsRoot
	})

	releaseDir := filepath.Join(appsRoot, "demo", "releases", "abc123")
	staticRoot := filepath.Join(releaseDir, "static")
	if err := os.MkdirAll(staticRoot, 0755); err != nil {
		t.Fatal(err)
	}
	writeMetadata(t, releaseDir, metadata{
		App:       "demo",
		Release:   "abc123",
		Kind:      "static",
		Root:      staticRoot,
		CreatedAt: "2026-05-18T00:00:00Z",
	})

	releases, _, err := scanMetadata()
	if err != nil {
		t.Fatal(err)
	}
	meta, ok := releases["abc123"]
	if !ok {
		t.Fatal("expected valid static metadata to load")
	}
	if meta.App != "demo" || meta.Release != "abc123" || meta.Root != staticRoot {
		t.Fatalf("metadata was not normalized from trusted path fields: %#v", meta)
	}
}

func writeMetadata(t *testing.T, releaseDir string, meta metadata) {
	t.Helper()
	payload, err := json.Marshal(meta)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(releaseDir, "metadata.json"), payload, 0644); err != nil {
		t.Fatal(err)
	}
}

func BenchmarkScanMetadata(b *testing.B) {
	originalAppsRoot := appsRoot
	appsRoot = b.TempDir()
	b.Cleanup(func() {
		appsRoot = originalAppsRoot
	})

	for appIndex := 0; appIndex < 20; appIndex++ {
		app := fmt.Sprintf("app-%02d", appIndex)
		for releaseIndex := 0; releaseIndex < 50; releaseIndex++ {
			release := fmt.Sprintf("r%06d", appIndex*50+releaseIndex)
			releaseDir := filepath.Join(appsRoot, app, "releases", release)
			if err := os.MkdirAll(releaseDir, 0755); err != nil {
				b.Fatal(err)
			}
			payload, err := json.Marshal(metadata{
				App:       app,
				Release:   release,
				Kind:      "executable",
				Type:      "bun",
				CreatedAt: "2026-05-18T00:00:00Z",
			})
			if err != nil {
				b.Fatal(err)
			}
			if err := os.WriteFile(filepath.Join(releaseDir, "metadata.json"), payload, 0644); err != nil {
				b.Fatal(err)
			}
		}
	}

	b.ResetTimer()
	for i := 0; i < b.N; i++ {
		releases, _, err := scanMetadata()
		if err != nil {
			b.Fatal(err)
		}
		if len(releases) != 1000 {
			b.Fatalf("loaded %d releases, want 1000", len(releases))
		}
	}
}
