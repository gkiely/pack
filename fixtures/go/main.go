package main

import (
	"fmt"
	"net/http"
	"os"
	"time"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "3000"
	}

	http.HandleFunc("/", func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("content-type", "text/plain; charset=utf-8")
		fmt.Fprintf(w, "hello from go\n%s\n", time.Now().UTC().Format(time.RFC3339Nano))
	})

	if err := http.ListenAndServe(":"+port, nil); err != nil {
		panic(err)
	}
}
