package main

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"net/http/httputil"
	"net/url"
	"os"
	"os/exec"
	"os/user"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	runRoot       = "/run/pack"
	socketPath    = "/run/pack/supervisor.sock"
	portStart     = 41001
	portEnd       = 60999
	startTimeout  = 5 * time.Second
	cacheTTL      = 30 * 24 * time.Hour
	releaseDomain = ".pack.sh"
	gzipLevel     = gzip.DefaultCompression
)

var appsRoot = "/var/pack/apps"

type metadata struct {
	App       string `json:"app"`
	Release   string `json:"release"`
	Kind      string `json:"kind"`
	Type      string `json:"type"`
	Service   string `json:"service,omitempty"`
	Root      string `json:"root,omitempty"`
	CreatedAt string `json:"createdAt"`
}

type supervisor struct {
	mu           sync.Mutex
	ports        map[string]int
	locks        map[string]*sync.Mutex
	starting     map[string]*startCall
	releases     map[string]metadata
	currentByApp map[string]string
	transport    *http.Transport
}

type startCall struct {
	done chan struct{}
	port int
	err  error
}

func main() {
	if err := os.MkdirAll(runRoot, 0755); err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(runRoot, "releases"), 0755); err != nil {
		log.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(runRoot, "ports"), 0755); err != nil {
		log.Fatal(err)
	}
	if err := os.RemoveAll(socketPath); err != nil {
		log.Fatal(err)
	}

	listener, err := net.Listen("unix", socketPath)
	if err != nil {
		log.Fatal(err)
	}
	if err := restrictSocket(socketPath); err != nil {
		log.Fatal(err)
	}

	s := &supervisor{
		ports:        map[string]int{},
		locks:        map[string]*sync.Mutex{},
		starting:     map[string]*startCall{},
		releases:     map[string]metadata{},
		currentByApp: map[string]string{},
		transport: &http.Transport{
			Proxy:                 http.ProxyFromEnvironment,
			DialContext:           (&net.Dialer{Timeout: 2 * time.Second, KeepAlive: 30 * time.Second}).DialContext,
			ForceAttemptHTTP2:     false,
			MaxIdleConns:          1024,
			MaxIdleConnsPerHost:   256,
			IdleConnTimeout:       90 * time.Second,
			TLSHandshakeTimeout:   2 * time.Second,
			ExpectContinueTimeout: 1 * time.Second,
		},
	}
	if err := s.reloadMetadata(); err != nil {
		log.Printf("reload metadata: %v", err)
	}
	s.rebuildRuntimeState()
	s.pruneExpiredInactiveReleases()
	go s.pruneLoop()

	server := &http.Server{
		Handler: s,
	}

	log.Printf("pack supervisor listening on %s", socketPath)
	log.Fatal(server.Serve(listener))
}

func restrictSocket(path string) error {
	group, err := user.LookupGroup("pack")
	if err != nil {
		return err
	}
	gid, err := strconv.Atoi(group.Gid)
	if err != nil {
		return err
	}
	if err := os.Chown(path, 0, gid); err != nil {
		return err
	}
	return os.Chmod(path, 0660)
}

func (s *supervisor) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	internalHost := strings.Split(r.Host, ":")[0] == "pack-supervisor"
	if internalHost && r.URL.Path == "/health" {
		w.WriteHeader(http.StatusOK)
		_, _ = io.WriteString(w, "ok\n")
		return
	}

	if internalHost && strings.HasPrefix(r.URL.Path, "/releases/") {
		s.handleReleaseAPI(w, r)
		return
	}

	release := releaseFromHost(r.Host)
	if release == "" {
		http.NotFound(w, r)
		return
	}

	meta, ok := s.lookupRelease(release)
	if !ok {
		http.NotFound(w, r)
		return
	}

	switch meta.Kind {
	case "static":
		serveStatic(w, r, meta.Root)
	case "executable":
		if !s.isCurrentRelease(meta) {
			s.serveInactiveExecutable(w, r, meta)
			return
		}

		port, err := s.ensureStarted(meta)
		if err != nil {
			log.Printf("start %s: %v", release, err)
			http.Error(w, "pack instance unavailable", http.StatusServiceUnavailable)
			return
		}
		s.proxyToPort(w, r, port)
	default:
		http.NotFound(w, r)
	}
}

func (s *supervisor) serveInactiveExecutable(w http.ResponseWriter, r *http.Request, meta metadata) {
	lock := s.releaseLock(meta.Release)
	lock.Lock()
	defer lock.Unlock()

	port, err := s.ensureStarted(meta)
	if err != nil {
		log.Printf("start %s: %v", meta.Release, err)
		http.Error(w, "pack instance unavailable", http.StatusServiceUnavailable)
		return
	}
	if err := touchLastAccess(meta); err != nil {
		log.Printf("touch inactive %s: %v", meta.Release, err)
	}
	s.proxyToPort(w, r, port)
	if err := systemctl("stop", "pack-"+meta.Release); err != nil {
		log.Printf("stop inactive %s: %v", meta.Release, err)
	}
	s.releasePort(meta.Release)
	if err := s.compressInactiveExecutable(meta); err != nil {
		log.Printf("compress inactive %s: %v", meta.Release, err)
	}
}

func (s *supervisor) pruneLoop() {
	ticker := time.NewTicker(24 * time.Hour)
	defer ticker.Stop()
	for range ticker.C {
		s.pruneExpiredInactiveReleases()
	}
}

func (s *supervisor) pruneExpiredInactiveReleases() {
	if err := s.reloadMetadata(); err != nil {
		log.Printf("prune reload metadata: %v", err)
		return
	}

	s.mu.Lock()
	releases := make([]metadata, 0, len(s.releases))
	for _, meta := range s.releases {
		releases = append(releases, meta)
	}
	currentByApp := make(map[string]string, len(s.currentByApp))
	for app, release := range s.currentByApp {
		currentByApp[app] = release
	}
	s.mu.Unlock()

	cutoff := time.Now().Add(-cacheTTL)
	for _, meta := range releases {
		if meta.Kind != "executable" || meta.App == "" || meta.Release == "" {
			continue
		}
		if currentByApp[meta.App] == meta.Release {
			continue
		}
		lastAccess, err := releaseLastAccess(meta)
		if err != nil {
			log.Printf("prune last access %s: %v", meta.Release, err)
			continue
		}
		if lastAccess.After(cutoff) {
			continue
		}
		if err := s.removeRelease(meta); err != nil {
			log.Printf("prune inactive %s: %v", meta.Release, err)
		}
	}
	_ = s.reloadMetadata()
}

func (s *supervisor) removeRelease(meta metadata) error {
	if err := systemctl("disable", "--now", "pack-"+meta.Release); err != nil && !strings.Contains(err.Error(), "not loaded") {
		log.Printf("disable inactive %s: %v", meta.Release, err)
	}
	s.releasePort(meta.Release)
	_ = os.Remove(filepath.Join("/etc/systemd/system", "pack-"+meta.Release+".service"))
	_ = os.Remove(filepath.Join("/etc/caddy/routes.d", meta.Release+".caddy"))
	_ = os.Remove(filepath.Join("/etc/caddy/conf.d", meta.Release+".caddy"))
	if err := os.RemoveAll(releaseRoot(meta)); err != nil {
		return err
	}
	return systemctl("daemon-reload")
}

func (s *supervisor) releaseLock(release string) *sync.Mutex {
	s.mu.Lock()
	defer s.mu.Unlock()
	lock := s.locks[release]
	if lock == nil {
		lock = &sync.Mutex{}
		s.locks[release] = lock
	}
	return lock
}

func (s *supervisor) lookupRelease(release string) (metadata, bool) {
	s.mu.Lock()
	meta, ok := s.releases[release]
	s.mu.Unlock()
	if ok {
		return meta, true
	}

	if err := s.reloadMetadata(); err != nil {
		log.Printf("reload metadata: %v", err)
		return metadata{}, false
	}

	s.mu.Lock()
	meta, ok = s.releases[release]
	s.mu.Unlock()
	return meta, ok
}

func (s *supervisor) handleReleaseAPI(w http.ResponseWriter, r *http.Request) {
	parts := strings.Split(strings.Trim(r.URL.Path, "/"), "/")
	if len(parts) != 3 || parts[0] != "releases" {
		http.NotFound(w, r)
		return
	}

	release := parts[1]
	action := parts[2]
	if !validRelease(release) {
		http.Error(w, "invalid release", http.StatusBadRequest)
		return
	}

	_ = s.reloadMetadata()
	meta, ok := s.lookupRelease(release)
	if !ok {
		http.NotFound(w, r)
		return
	}

	switch action {
	case "start":
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if meta.Kind == "static" {
			writeJSON(w, map[string]any{"release": release, "kind": "static", "status": "ready"})
			return
		}
		port, err := s.ensureStarted(meta)
		if err != nil {
			http.Error(w, err.Error(), http.StatusServiceUnavailable)
			return
		}
		writeJSON(w, map[string]any{"release": release, "kind": meta.Kind, "status": "running", "port": port})
	case "stop":
		if r.Method != http.MethodPost {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		if meta.Kind == "executable" {
			if err := systemctl("stop", "pack-"+release); err != nil {
				http.Error(w, err.Error(), http.StatusServiceUnavailable)
				return
			}
			s.releasePort(release)
			if err := s.compressInactiveExecutable(meta); err != nil {
				http.Error(w, err.Error(), http.StatusServiceUnavailable)
				return
			}
		}
		writeJSON(w, map[string]any{"release": release, "status": "stopped"})
	case "status":
		if r.Method != http.MethodGet {
			http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
			return
		}
		status := "static"
		port := 0
		if meta.Kind == "executable" {
			if isActive("pack-" + release) {
				status = "running"
				port = s.portForRelease(release)
			} else {
				status = "stopped"
			}
		}
		writeJSON(w, map[string]any{"release": release, "kind": meta.Kind, "status": status, "port": port})
	default:
		http.NotFound(w, r)
	}
}

func (s *supervisor) ensureStarted(meta metadata) (int, error) {
	release := meta.Release

	s.mu.Lock()
	if port := s.ports[release]; port != 0 {
		s.mu.Unlock()
		return port, nil
	}
	if call := s.starting[release]; call != nil {
		s.mu.Unlock()
		<-call.done
		return call.port, call.err
	}
	call := &startCall{done: make(chan struct{})}
	s.starting[release] = call
	s.mu.Unlock()

	call.port, call.err = s.start(meta)

	s.mu.Lock()
	delete(s.starting, release)
	if call.err == nil {
		s.ports[release] = call.port
	}
	s.mu.Unlock()
	close(call.done)

	return call.port, call.err
}

func (s *supervisor) start(meta metadata) (int, error) {
	if err := restoreCompressedExecutable(meta); err != nil {
		return 0, err
	}
	port, err := s.allocatePort(meta.Release)
	if err != nil {
		return 0, err
	}
	if err := writeEnv(meta.Release, port); err != nil {
		s.releasePort(meta.Release)
		return 0, err
	}
	if err := systemctl("start", "pack-"+meta.Release); err != nil {
		s.releasePort(meta.Release)
		return 0, err
	}
	if err := waitReady(port); err != nil {
		_ = systemctl("stop", "pack-"+meta.Release)
		s.releasePort(meta.Release)
		return 0, err
	}
	return port, nil
}

func (s *supervisor) allocatePort(release string) (int, error) {
	s.mu.Lock()
	defer s.mu.Unlock()

	used := map[int]bool{}
	for _, port := range s.ports {
		used[port] = true
	}
	for port := portStart; port <= portEnd; port++ {
		if used[port] || portListening(port) {
			continue
		}
		s.ports[release] = port
		_ = os.WriteFile(filepath.Join(runRoot, "ports", strconv.Itoa(port)), []byte(release+"\n"), 0644)
		return port, nil
	}
	return 0, errors.New("no ports available")
}

func (s *supervisor) releasePort(release string) {
	s.mu.Lock()
	port := s.ports[release]
	delete(s.ports, release)
	s.mu.Unlock()

	_ = os.Remove(envPath(release))
	if port != 0 {
		_ = os.Remove(filepath.Join(runRoot, "ports", strconv.Itoa(port)))
	}
}

func (s *supervisor) portForRelease(release string) int {
	s.mu.Lock()
	defer s.mu.Unlock()
	if port := s.ports[release]; port != 0 {
		return port
	}
	port, _ := readEnvPort(release)
	if port != 0 {
		s.ports[release] = port
	}
	return port
}

func (s *supervisor) rebuildRuntimeState() {
	files, _ := filepath.Glob(filepath.Join(runRoot, "releases", "*.env"))
	for _, file := range files {
		release := strings.TrimSuffix(filepath.Base(file), ".env")
		if !validRelease(release) || !isActive("pack-"+release) {
			continue
		}
		port, err := readEnvPort(release)
		if err == nil && port != 0 {
			s.ports[release] = port
		}
	}
}

func (s *supervisor) reloadMetadata() error {
	releases, currentByApp, err := scanMetadata()
	if err != nil {
		return err
	}
	s.mu.Lock()
	s.releases = releases
	s.currentByApp = currentByApp
	s.mu.Unlock()
	return nil
}

func (s *supervisor) isCurrentRelease(meta metadata) bool {
	if meta.App == "" || meta.Release == "" {
		return false
	}
	s.mu.Lock()
	current := s.currentByApp[meta.App]
	s.mu.Unlock()
	return current == meta.Release
}

func (s *supervisor) compressInactiveExecutable(meta metadata) error {
	if meta.Kind != "executable" || !compressibleAppType(meta.Type) || s.isCurrentRelease(meta) {
		return nil
	}
	if _, err := os.Stat(compressedExecutablePath(meta)); err == nil {
		if err := os.Remove(executablePath(meta)); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return compressExecutable(meta)
}

func releaseRoot(meta metadata) string {
	return filepath.Join(appsRoot, meta.App, "releases", meta.Release)
}

func executablePath(meta metadata) string {
	return filepath.Join(releaseRoot(meta), "app")
}

func compressedExecutablePath(meta metadata) string {
	return filepath.Join(releaseRoot(meta), "app.gz")
}

func compressibleAppType(appType string) bool {
	switch appType {
	case "bun", "node", "deno":
		return true
	default:
		return false
	}
}

func compressExecutable(meta metadata) error {
	appPath := executablePath(meta)
	gzPath := compressedExecutablePath(meta)
	if _, err := os.Stat(gzPath); err == nil {
		_ = os.Remove(appPath)
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}

	input, err := os.Open(appPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer input.Close()

	tmpPath := gzPath + ".tmp"
	output, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0644)
	if err != nil {
		return err
	}
	writer, err := gzip.NewWriterLevel(output, gzipLevel)
	if err != nil {
		_ = output.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if _, err := io.Copy(writer, input); err != nil {
		_ = writer.Close()
		_ = output.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := writer.Close(); err != nil {
		_ = output.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := output.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Rename(tmpPath, gzPath); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return os.Remove(appPath)
}

func restoreCompressedExecutable(meta metadata) error {
	appPath := executablePath(meta)
	if _, err := os.Stat(appPath); err == nil {
		return nil
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}

	gzPath := compressedExecutablePath(meta)
	input, err := os.Open(gzPath)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	defer input.Close()

	reader, err := gzip.NewReader(input)
	if err != nil {
		return err
	}
	defer reader.Close()

	tmpPath := appPath + ".tmp"
	output, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0755)
	if err != nil {
		return err
	}
	if _, err := io.Copy(output, reader); err != nil {
		_ = output.Close()
		_ = os.Remove(tmpPath)
		return err
	}
	if err := output.Close(); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	if err := os.Chmod(tmpPath, 0755); err != nil {
		_ = os.Remove(tmpPath)
		return err
	}
	return os.Rename(tmpPath, appPath)
}

func lastAccessPath(meta metadata) string {
	return filepath.Join(releaseRoot(meta), ".last-access")
}

func touchLastAccess(meta metadata) error {
	now := time.Now().UTC().Format(time.RFC3339Nano)
	return os.WriteFile(lastAccessPath(meta), []byte(now+"\n"), 0644)
}

func releaseLastAccess(meta metadata) (time.Time, error) {
	content, err := os.ReadFile(lastAccessPath(meta))
	if err == nil {
		if ts, parseErr := time.Parse(time.RFC3339Nano, strings.TrimSpace(string(content))); parseErr == nil {
			return ts, nil
		}
	}
	if meta.CreatedAt != "" {
		if ts, parseErr := time.Parse(time.RFC3339Nano, meta.CreatedAt); parseErr == nil {
			return ts, nil
		}
		if ts, parseErr := time.Parse(time.RFC3339, meta.CreatedAt); parseErr == nil {
			return ts, nil
		}
	}
	info, statErr := os.Stat(releaseRoot(meta))
	if statErr != nil {
		return time.Time{}, statErr
	}
	return info.ModTime(), nil
}

func scanMetadata() (map[string]metadata, map[string]string, error) {
	releasesByID := map[string]metadata{}
	currentByApp := map[string]string{}
	apps, err := os.ReadDir(appsRoot)
	if err != nil {
		if errors.Is(err, os.ErrNotExist) {
			return releasesByID, currentByApp, nil
		}
		return nil, nil, err
	}
	for _, app := range apps {
		if !app.IsDir() {
			continue
		}
		appName := app.Name()
		if target, err := os.Readlink(filepath.Join(appsRoot, appName, "current")); err == nil {
			currentByApp[appName] = filepath.Base(target)
		}
		paths, err := filepath.Glob(filepath.Join(appsRoot, appName, "releases", "*", "metadata.json"))
		if err != nil {
			continue
		}
		for _, path := range paths {
			release := filepath.Base(filepath.Dir(path))
			if !validRelease(release) {
				continue
			}
			content, err := os.ReadFile(path)
			if err != nil {
				continue
			}
			var meta metadata
			if err := json.Unmarshal(content, &meta); err != nil {
				return nil, nil, err
			}
			normalized, ok := normalizeMetadata(appName, release, meta)
			if ok {
				releasesByID[release] = normalized
			}
		}
	}
	return releasesByID, currentByApp, nil
}

func normalizeMetadata(app string, release string, meta metadata) (metadata, bool) {
	if !validApp(app) || !validRelease(release) {
		return metadata{}, false
	}
	if meta.Release != "" && meta.Release != release {
		return metadata{}, false
	}
	if meta.App != "" && meta.App != app {
		return metadata{}, false
	}
	switch meta.Kind {
	case "executable":
		meta.App = app
		meta.Release = release
		meta.Root = ""
		return meta, true
	case "static":
		meta.App = app
		meta.Release = release
		expectedRoot := filepath.Join(releaseRoot(meta), "static")
		cleanRoot := filepath.Clean(meta.Root)
		if cleanRoot != expectedRoot {
			return metadata{}, false
		}
		meta.Root = expectedRoot
		return meta, true
	default:
		return metadata{}, false
	}
}

func serveStatic(w http.ResponseWriter, r *http.Request, root string) {
	if root == "" {
		http.NotFound(w, r)
		return
	}
	cleanPath := filepath.Clean("/" + r.URL.Path)
	target := filepath.Join(root, cleanPath)
	if info, err := os.Stat(target); err == nil {
		if info.IsDir() {
			index := filepath.Join(target, "index.html")
			if _, err := os.Stat(index); err == nil {
				http.ServeFile(w, r, index)
				return
			}
		} else {
			http.ServeFile(w, r, target)
			return
		}
	}
	http.ServeFile(w, r, filepath.Join(root, "index.html"))
}

func (s *supervisor) proxyToPort(w http.ResponseWriter, r *http.Request, port int) {
	target, _ := url.Parse(fmt.Sprintf("http://127.0.0.1:%d", port))
	proxy := httputil.NewSingleHostReverseProxy(target)
	proxy.Transport = s.transport
	proxy.ErrorHandler = func(w http.ResponseWriter, r *http.Request, err error) {
		log.Printf("proxy %d: %v", port, err)
		http.Error(w, "pack instance unavailable", http.StatusBadGateway)
	}
	proxy.ServeHTTP(w, r)
}

func writeEnv(release string, port int) error {
	if err := os.MkdirAll(filepath.Join(runRoot, "releases"), 0755); err != nil {
		return err
	}
	return os.WriteFile(envPath(release), []byte(fmt.Sprintf("PORT=%d\n", port)), 0644)
}

func envPath(release string) string {
	return filepath.Join(runRoot, "releases", release+".env")
}

func readEnvPort(release string) (int, error) {
	content, err := os.ReadFile(envPath(release))
	if err != nil {
		return 0, err
	}
	for _, line := range strings.Split(string(content), "\n") {
		if strings.HasPrefix(line, "PORT=") {
			return strconv.Atoi(strings.TrimPrefix(line, "PORT="))
		}
	}
	return 0, errors.New("missing PORT")
}

func waitReady(port int) error {
	client := &http.Client{Timeout: 500 * time.Millisecond}
	deadline := time.Now().Add(startTimeout)
	url := fmt.Sprintf("http://127.0.0.1:%d/", port)
	var lastErr error
	for time.Now().Before(deadline) {
		resp, err := client.Get(url)
		if err == nil {
			_, _ = io.Copy(io.Discard, resp.Body)
			_ = resp.Body.Close()
			if resp.StatusCode == http.StatusOK {
				return nil
			}
			lastErr = fmt.Errorf("status %d", resp.StatusCode)
		} else {
			lastErr = err
		}
		time.Sleep(100 * time.Millisecond)
	}
	return fmt.Errorf("release did not become ready: %w", lastErr)
}

func systemctl(args ...string) error {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	output, err := exec.CommandContext(ctx, "systemctl", args...).CombinedOutput()
	if err != nil {
		return fmt.Errorf("systemctl %s: %w: %s", strings.Join(args, " "), err, strings.TrimSpace(string(output)))
	}
	return nil
}

func isActive(service string) bool {
	return exec.Command("systemctl", "is-active", "--quiet", service).Run() == nil
}

func portListening(port int) bool {
	conn, err := net.DialTimeout("tcp", fmt.Sprintf("127.0.0.1:%d", port), 50*time.Millisecond)
	if err != nil {
		return false
	}
	_ = conn.Close()
	return true
}

func releaseFromHost(host string) string {
	host = strings.ToLower(strings.Split(host, ":")[0])
	if !strings.HasSuffix(host, releaseDomain) {
		return ""
	}
	release := strings.TrimSuffix(host, releaseDomain)
	if strings.Contains(release, ".") || !validRelease(release) {
		return ""
	}
	return release
}

func validRelease(release string) bool {
	if release == "" {
		return false
	}
	for _, r := range release {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') {
			return false
		}
	}
	return true
}

func validApp(app string) bool {
	if app == "" {
		return false
	}
	for _, r := range app {
		if (r < 'a' || r > 'z') && (r < '0' || r > '9') && r != '-' {
			return false
		}
	}
	return true
}

func writeJSON(w http.ResponseWriter, value any) {
	w.Header().Set("content-type", "application/json")
	if err := json.NewEncoder(w).Encode(value); err != nil {
		log.Printf("write json: %v", err)
	}
}
