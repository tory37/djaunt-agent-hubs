package main

import (
	"fmt"
	"os"
)

func main() {
	fmt.Fprintln(os.Stderr, "djt-hub: commands arrive in phase 2")
	os.Exit(1)
}
