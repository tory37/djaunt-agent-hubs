package client

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strconv"
	"strings"

	"github.com/tory37/djaunt-agent-hubs/internal/server"
)

var ErrWaitTimedOut = errors.New("timed out waiting for event")

type APIError struct {
	Status  int
	Message string
}

func (e *APIError) Error() string { return fmt.Sprintf("%s (HTTP %d)", e.Message, e.Status) }

type Client struct {
	baseURL string
	source  string
	http    *http.Client
}

func New(address, source string) *Client {
	baseURL := address
	if !strings.HasPrefix(baseURL, "http://") && !strings.HasPrefix(baseURL, "https://") {
		baseURL = "http://" + baseURL
	}
	return &Client{baseURL: strings.TrimRight(baseURL, "/"), source: source, http: &http.Client{}}
}

func (c *Client) BaseURL() string { return c.baseURL }

func HubPath(hubID string, suffix ...string) string {
	path := "/api/hubs/" + url.PathEscape(hubID)
	for _, part := range suffix {
		path += "/" + url.PathEscape(part)
	}
	return path
}

// Do sends body as JSON (raw bytes pass through untouched) and decodes the
// response into out when out is non-nil.
func (c *Client) Do(ctx context.Context, method, path string, body any, out any) error {
	response, err := c.send(ctx, method, path, body)
	if err != nil {
		return err
	}
	defer response.Body.Close()
	return decodeResponse(response, out)
}

func (c *Client) send(ctx context.Context, method, path string, body any) (*http.Response, error) {
	var requestBody io.Reader
	switch typed := body.(type) {
	case nil:
	case []byte:
		requestBody = bytes.NewReader(typed)
	case json.RawMessage:
		requestBody = bytes.NewReader(typed)
	default:
		encoded, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		requestBody = bytes.NewReader(encoded)
	}
	request, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, requestBody)
	if err != nil {
		return nil, err
	}
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set(server.SourceHeader, c.source)
	response, err := c.http.Do(request)
	if err != nil {
		return nil, fmt.Errorf("djt-hub daemon unreachable at %s (run `djt-hub serve` or `djt-hub install`): %w", c.baseURL, err)
	}
	return response, nil
}

func decodeResponse(response *http.Response, out any) error {
	body, err := io.ReadAll(response.Body)
	if err != nil {
		return err
	}
	if response.StatusCode >= 400 {
		var errorBody struct {
			Error string `json:"error"`
		}
		json.Unmarshal(body, &errorBody)
		if errorBody.Error == "" {
			errorBody.Error = strings.TrimSpace(string(body))
		}
		return &APIError{Status: response.StatusCode, Message: errorBody.Error}
	}
	if out == nil {
		return nil
	}
	if raw, wantsRaw := out.(*json.RawMessage); wantsRaw {
		*raw = append((*raw)[:0], body...)
		return nil
	}
	return json.Unmarshal(body, out)
}

type WaitOptions struct {
	Type     string
	Matchers []string
	Since    string
	Timeout  string
}

func (c *Client) Wait(ctx context.Context, hubID string, options WaitOptions) (json.RawMessage, error) {
	query := url.Values{}
	setIfPresent(query, "type", options.Type)
	setIfPresent(query, "since", options.Since)
	setIfPresent(query, "timeout", options.Timeout)
	for _, matcher := range options.Matchers {
		query.Add("match", matcher)
	}
	var event json.RawMessage
	err := c.Do(ctx, http.MethodGet, HubPath(hubID, "wait")+"?"+query.Encode(), nil, &event)
	var apiError *APIError
	if errors.As(err, &apiError) && apiError.Status == http.StatusRequestTimeout {
		return nil, ErrWaitTimedOut
	}
	return event, err
}

type StreamMessage struct {
	Kind string
	Seq  int64
	Data json.RawMessage
}

// Stream reads the SSE feed until ctx ends or the connection drops. It returns
// the last event seq seen so callers can resume.
func (c *Client) Stream(ctx context.Context, hubID string, afterSeq int64, eventType string, onMessage func(StreamMessage)) (int64, error) {
	query := url.Values{}
	query.Set("since", strconv.FormatInt(afterSeq, 10))
	setIfPresent(query, "type", eventType)
	response, err := c.send(ctx, http.MethodGet, HubPath(hubID, "stream")+"?"+query.Encode(), nil)
	if err != nil {
		return afterSeq, err
	}
	defer response.Body.Close()
	if response.StatusCode >= 400 {
		return afterSeq, decodeResponse(response, nil)
	}

	lastSeq := afterSeq
	scanner := bufio.NewScanner(response.Body)
	scanner.Buffer(make([]byte, 64*1024), 8<<20)
	var pending StreamMessage
	for scanner.Scan() {
		line := scanner.Text()
		switch {
		case line == "":
			if pending.Kind != "" {
				if pending.Seq > lastSeq {
					lastSeq = pending.Seq
				}
				onMessage(pending)
			}
			pending = StreamMessage{}
		case strings.HasPrefix(line, "event: "):
			pending.Kind = strings.TrimPrefix(line, "event: ")
		case strings.HasPrefix(line, "id: "):
			pending.Seq, _ = strconv.ParseInt(strings.TrimPrefix(line, "id: "), 10, 64)
		case strings.HasPrefix(line, "data: "):
			pending.Data = json.RawMessage(strings.TrimPrefix(line, "data: "))
		}
	}
	if ctx.Err() != nil {
		return lastSeq, ctx.Err()
	}
	return lastSeq, scanner.Err()
}

func setIfPresent(query url.Values, key, value string) {
	if value != "" {
		query.Set(key, value)
	}
}
