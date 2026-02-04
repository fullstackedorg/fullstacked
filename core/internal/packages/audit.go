package packages

import (
	"bytes"
	"encoding/json"
	"errors"
	"fullstackedorg/fullstacked/internal/fs"
	"io"
	"net/http"
	"path"
	"strings"
)

// AuditPayload represents the bulk advisory payload format
// Map of package name to list of versions
type AuditPayload map[string][]string

func audit(directory string) (map[string]interface{}, error) {
	// 1. Read package-lock.json
	packageLockPath := path.Join(directory, "package-lock.json")
	lockContent, err := fs.ReadFileFn(packageLockPath)
	if err != nil {
		return nil, errors.New("failed to read package-lock.json: " + err.Error())
	}

	var lock PackageLock
	if err := json.Unmarshal(lockContent, &lock); err != nil {
		return nil, errors.New("failed to parse package-lock.json: " + err.Error())
	}

	// 2. Build Bulk Payload (Map: package -> versions)
	payloadMap := make(AuditPayload)

	// Helper to extract package name from node_modules path
	// e.g., "node_modules/foo" -> "foo"
	// "node_modules/@scope/pkg" -> "@scope/pkg"
	getNameFromPath := func(p string) string {
		parts := strings.Split(p, "node_modules/")
		ifSC := len(parts)
		if ifSC == 0 {
			return ""
		}
		// The last part is the package name relative to the nearest node_modules
		// But in a flat v3 structure, keys are relative paths from root.
		last := parts[len(parts)-1]
		return strings.TrimSuffix(last, "/")
	}

	for p, pkg := range lock.Packages {
		if p == "" {
			continue // Root package
		}

		// strict filtering: we only care about installed dependencies in node_modules
		// This avoids treating local workspace paths (e.g. "platform/node") as package names.
		if !strings.Contains(p, "node_modules/") {
			continue
		}

		if pkg.Version == "" {
			continue
		}

		name := getNameFromPath(p)
		if name == "" {
			continue
		}

		// Optional: Basic validation of package name to avoid sending garbage
		// e.g. names shouldn't contain "/" unless scoped
		// But getNameFromPath logic should handle standard node_modules structure.

		// Append version
		if _, ok := payloadMap[name]; !ok {
			payloadMap[name] = []string{}
		}

		// Avoid duplicates for same package version
		exists := false
		for _, v := range payloadMap[name] {
			if v == pkg.Version {
				exists = true
				break
			}
		}
		if !exists {
			payloadMap[name] = append(payloadMap[name], pkg.Version)
		}
	}

	payload, err := json.Marshal(payloadMap)
	if err != nil {
		return nil, errors.New("failed to marshal audit payload: " + err.Error())
	}

	// 3. Send Request to Bulk Endpoint
	url := registryBaseUrl + "-/npm/v1/security/advisories/bulk"
	req, err := http.NewRequest("POST", url, bytes.NewBuffer(payload))
	if err != nil {
		return nil, errors.New("failed to create request: " + err.Error())
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")

	resp, err := httpClient.Do(req)
	if err != nil {
		return nil, errors.New("failed to perform audit: " + err.Error())
	}
	defer resp.Body.Close()

	if resp.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(resp.Body)
		if resp.StatusCode == http.StatusBadRequest {
			return nil, errors.New("audit failed: " + resp.Status + " " + string(body) + " Payload: " + string(payload))
		}
		return nil, errors.New("audit failed: " + resp.Status + " " + string(body))
	}

	// 4. Parse Response
	// The bulk endpoint returns a map of package name to advisory objects
	var report map[string]interface{}
	if err := json.NewDecoder(resp.Body).Decode(&report); err != nil {
		return nil, errors.New("failed to parse audit report: " + err.Error())
	}

	return report, nil
}
