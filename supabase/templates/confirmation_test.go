package confirmation

import (
	"bytes"
	"html/template"
	"net/url"
	"os"
	"strings"
	"testing"
)

func TestConfirmation(t *testing.T) {
	source, err := os.ReadFile("confirmation.html")
	if err != nil {
		t.Fatal(err)
	}
	tpl, err := template.New("confirmation").Parse(string(source))
	if err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{
		"https://other.example.test/auth/callback",
		"http://app.example.test/auth/callback",
		"https://app.example.test:444/auth/callback",
		"https://www.app.example.test.evil.test/auth/callback",
		"https://app.example.test@evil.test/auth/callback",
		"https://app.example.test",
		"https://app.example.test/",
		"https://app.example.test/dashboard?next=home",
		"https://app.example.test/auth/callback-extra",
		"https://app.example.test/auth/mobile/callback?state=browser-state",
		"kortix://auth/callback?state=native-state",
		"https://app.example.test/auth/callback",
		"https://app.example.test/auth/callback?returnUrl=%2Fworkspaces&terms_accepted=true"} {
		t.Run(target, func(t *testing.T) {
			confirmation := "https://auth.example.test/verify?token=synthetic&type=signup"
			var b bytes.Buffer
			err := tpl.Execute(&b, map[string]string{"RedirectTo": target, "TokenHash": "synthetic-hash", "ConfirmationURL": confirmation, "SiteURL": "https://app.example.test"})
			if err != nil {
				t.Fatal(err)
			}
			html := b.String()
			start := strings.Index(html, `href="`) + 6
			end := strings.Index(html[start:], `"`) + start
			link := strings.ReplaceAll(html[start:end], "&amp;", "&")
			targetURL, err := url.Parse(target)
			if err != nil {
				t.Fatal(err)
			}
			if targetURL.Scheme != "https" || targetURL.Host != "app.example.test" || (targetURL.Path != "/auth/callback" && targetURL.Path != "/auth/mobile/callback") {
				if link != confirmation {
					t.Fatalf("fallback link = %s", link)
				}
				return
			}
			u, err := url.Parse(link)
			if err != nil {
				t.Fatal(err)
			}
			if u.Path != "/auth/confirm" || u.Query().Get("token_hash") != "synthetic-hash" || u.Query().Get("redirect_to") != target {
				t.Fatalf("callback = %s", link)
			}
		})
	}
}

func TestSameSiteConfirmation(t *testing.T) {
	source, err := os.ReadFile("confirmation.html")
	if err != nil {
		t.Fatal(err)
	}
	tpl, err := template.New("confirmation").Parse(string(source))
	if err != nil {
		t.Fatal(err)
	}
	for _, site := range []string{"https://example.test", "https://www.example.test", "http://example.test:13000", "http://www.example.test:13000"} {
		for _, host := range []string{"example.test", "www.example.test", "evil.example.test", "example.test.evil.test"} {
			for _, path := range []string{"/auth/callback", "/auth/mobile/callback?state=synthetic", "/auth/callback-extra", "/dashboard"} {
				origin, _ := url.Parse(site)
				target := origin.Scheme + "://" + host
				if origin.Port() != "" {
					target += ":" + origin.Port()
				}
				target += path
				t.Run(site+"->"+target, func(t *testing.T) {
					confirmation := "https://auth.example.test/verify?token=synthetic&type=signup"
					var b bytes.Buffer
					if err := tpl.Execute(&b, map[string]string{"SiteURL": site, "RedirectTo": target, "TokenHash": "synthetic-hash", "ConfirmationURL": confirmation}); err != nil {
						t.Fatal(err)
					}
					rendered := b.String()
					start := strings.Index(rendered, `href="`) + 6
					end := strings.Index(rendered[start:], `"`) + start
					link := strings.ReplaceAll(rendered[start:end], "&amp;", "&")
					if (host != "example.test" && host != "www.example.test") || (path != "/auth/callback" && !strings.HasPrefix(path, "/auth/mobile/callback?")) {
						if link != confirmation {
							t.Fatalf("fallback = %s", link)
						}
						return
					}
					parsed, err := url.Parse(link)
					if err != nil {
						t.Fatal(err)
					}
					if parsed.Scheme+"://"+parsed.Host != site || parsed.Path != "/auth/confirm" || parsed.Query().Get("redirect_to") != target || parsed.Query().Get("token_hash") != "synthetic-hash" {
						t.Fatalf("adapter = %s", link)
					}
				})
			}
		}
	}
}
