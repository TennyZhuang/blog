package handler

import (
	"encoding/json"
	"io/ioutil"
	"math/rand"
	"net/http"
	"strings"
)

const CHI_CORPUS_URL = "https://raw.githubusercontent.com/TennyZhuang/Chi-Corpus/master/common.txt"

type Data struct {
	Content string `json:"content"`
}

func fetchChiCorpus() (*Data, error) {
	resp, err := http.Get(CHI_CORPUS_URL)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := ioutil.ReadAll(resp.Body)
	if err != nil {
		return nil, err
	}
	content := string(body)
	lines := strings.Split(content, "\n")
	line := lines[rand.Intn(len(lines))]
	return &Data{
		Content: line,
	}, nil
}

func Handler(w http.ResponseWriter, r *http.Request) {
	data, err := fetchChiCorpus()
	if err != nil {
		w.WriteHeader(http.StatusInternalServerError)
		w.Write([]byte(err.Error()))
	} else {
		w.Header().Set("Content-Type", "application/json")
		json.NewEncoder(w).Encode(data)
	}
}
