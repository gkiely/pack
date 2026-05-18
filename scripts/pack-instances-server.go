package main

import (
	_ "embed"
	"encoding/json"
	"log"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
)

//go:embed pack-instances.html
var instancesHTML string

var instancesCache = struct {
	sync.Mutex
	rows   []instance
	loaded bool
}{}

type instance struct {
	App       string `json:"app"`
	Type      string `json:"type"`
	Current   bool   `json:"current"`
	Release   string `json:"release"`
	Port      string `json:"port"`
	Service   string `json:"service"`
	URL       string `json:"url"`
	CreatedAt string `json:"createdAt,omitempty"`
}

func main() {
	http.HandleFunc("/instances", handleInstancesHTML)
	http.HandleFunc("/instances/", handleInstancesHTML)
	http.HandleFunc("/internal/refresh-instances", handleRefreshInstances)
	http.HandleFunc("/instances.json", func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/instances.json" {
			http.NotFound(w, r)
			return
		}

		w.Header().Set("content-type", "application/json; charset=utf-8")
		w.Header().Set("cache-control", "no-store")
		if err := json.NewEncoder(w).Encode(map[string][]instance{"instances": cachedInstances()}); err != nil {
			log.Printf("encode instances: %v", err)
		}
	})

	log.Fatal(http.ListenAndServe("127.0.0.1:40999", nil))
}

func handleRefreshInstances(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodPost {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	refreshInstances()
	w.WriteHeader(http.StatusNoContent)
}

func handleInstancesHTML(w http.ResponseWriter, r *http.Request) {
	if r.URL.Path != "/instances" && r.URL.Path != "/instances/" {
		http.NotFound(w, r)
		return
	}

	payload, err := json.Marshal(cachedInstances())
	if err != nil {
		http.Error(w, "failed to load instances", http.StatusInternalServerError)
		log.Printf("marshal instances: %v", err)
		return
	}

	w.Header().Set("content-type", "text/html; charset=utf-8")
	w.Header().Set("cache-control", "no-store")
	if _, err := w.Write([]byte(strings.Replace(instancesHTML, "__PACK_INSTANCES_JSON__", string(payload), 1))); err != nil {
		log.Printf("write instances html: %v", err)
	}
}

func cachedInstances() []instance {
	instancesCache.Lock()
	defer instancesCache.Unlock()

	if instancesCache.loaded {
		return append([]instance(nil), instancesCache.rows...)
	}

	rows := instances()
	instancesCache.rows = append([]instance(nil), rows...)
	instancesCache.loaded = true
	return append([]instance(nil), rows...)
}

func refreshInstances() {
	rows := instances()

	instancesCache.Lock()
	defer instancesCache.Unlock()

	instancesCache.rows = append([]instance(nil), rows...)
	instancesCache.loaded = true
}

func instances() []instance {
	rows := []instance{}
	if isActive("pack-reserved-hello") {
		rows = append(rows, instance{
			App:       "hello",
			Type:      "bun",
			Current:   true,
			Release:   "hello",
			Port:      "41000",
			Service:   "active",
			URL:       "https://hello.pack.sh/",
			CreatedAt: readCreatedAt("hello", "hello"),
		})
	}

	apps, err := os.ReadDir("/var/pack/apps")
	if err != nil {
		return rows
	}

	for _, appEntry := range apps {
		if !appEntry.IsDir() {
			continue
		}

		app := appEntry.Name()
		appRoot := filepath.Join("/var/pack/apps", app)
		releasesRoot := filepath.Join(appRoot, "releases")
		releases, err := os.ReadDir(releasesRoot)
		if err != nil {
			continue
		}

		current := ""
		if target, err := os.Readlink(filepath.Join(appRoot, "current")); err == nil {
			current = filepath.Base(target)
		}

		for _, releaseEntry := range releases {
			if !releaseEntry.IsDir() {
				continue
			}

			release := releaseEntry.Name()
			appType := readType(app, release)
			service := "inactive"
			if appType == "static" && staticActive(app, release) {
				service = "active"
			} else if isActive("pack-" + release) {
				service = "active"
			}

			rows = append(rows, instance{
				App:       app,
				Type:      appType,
				Current:   release == current,
				Release:   release,
				Port:      readPort(release),
				Service:   service,
				URL:       "https://" + release + ".pack.sh/",
				CreatedAt: readCreatedAt(app, release),
			})
		}
	}

	sort.Slice(rows, func(i, j int) bool {
		if rows[i].CreatedAt != rows[j].CreatedAt {
			return rows[i].CreatedAt > rows[j].CreatedAt
		}
		return rows[i].Release > rows[j].Release
	})
	return rows
}

func isActive(service string) bool {
	return exec.Command("systemctl", "is-active", "--quiet", service).Run() == nil
}

func staticActive(app string, release string) bool {
	if stat, err := os.Stat(filepath.Join("/var/pack/apps", app, "releases", release, "static")); err != nil || !stat.IsDir() {
		return false
	}
	return true
}

func readType(app string, release string) string {
	content, err := os.ReadFile(filepath.Join("/var/pack/apps", app, "releases", release, "type"))
	if err == nil {
		appType := strings.TrimSpace(string(content))
		if appType != "" {
			return appType
		}
	}

	switch app {
	case "go":
		return "go"
	case "rust":
		return "rust"
	case "zig":
		return "zig"
	case "nodejs":
		return "node"
	case "static-html":
		return "static"
	case "bun", "hn-cron":
		return "bun"
	default:
		return "custom"
	}
}

func readPort(release string) string {
	content, err := os.ReadFile(filepath.Join("/run/pack/releases", release+".env"))
	if err != nil {
		return ""
	}
	for _, line := range strings.Split(string(content), "\n") {
		if strings.HasPrefix(line, "PORT=") {
			return strings.TrimSpace(strings.TrimPrefix(line, "PORT="))
		}
	}
	return ""
}

func readCreatedAt(app string, release string) string {
	content, err := os.ReadFile(filepath.Join("/var/pack/apps", app, "releases", release, "metadata.json"))
	if err != nil {
		return ""
	}

	var metadata struct {
		CreatedAt string `json:"createdAt"`
	}
	if err := json.Unmarshal(content, &metadata); err != nil {
		return ""
	}
	return metadata.CreatedAt
}
