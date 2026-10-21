## راه‌اندازی MCP والکس

برای هر کلاینت، یکی از دو روش اتصال را انتخاب کنید: دسترسی عمومی یا احراز هویت با کلید API. ابزارهای عمومی به کلید API نیاز ندارند. ابزارهای خصوصی به هدر `X-API-Key` نیاز دارند.

برای دستورهایی که به کلید API نیاز دارند، ابتدا کد زیر را در `zsh` اجرا کنید:

```zsh
read -rs 'WALLEX_API_KEY?Wallex API key: '
printf '\n'
export WALLEX_API_KEY
```

## [Codex](https://developers.openai.com/codex/mcp)

### دسترسی عمومی

```bash
codex mcp add wallex --url https://api.wallex.ir/mcp
```

### احراز هویت با کلید API

بخش زیر را به فایل `~/.codex/config.toml` اضافه کنید یا جایگزین بخش موجود کنید:

```toml
[mcp_servers.wallex]
url = "https://api.wallex.ir/mcp"
env_http_headers = { "X-API-Key" = "WALLEX_API_KEY" }
```

## [Claude Code](https://code.claude.com/docs/en/mcp)

```bash
# Public access
claude mcp add --scope user --transport http wallex https://api.wallex.ir/mcp

# API-key authentication
claude mcp add --scope user --transport http wallex https://api.wallex.ir/mcp --header "X-API-Key: ${WALLEX_API_KEY}"
```

## [Gemini CLI](https://geminicli.com/docs/tools/mcp-server/)

```bash
# Public access
gemini mcp add --scope user --transport http wallex https://api.wallex.ir/mcp

# API-key authentication
gemini mcp add --scope user --transport http wallex https://api.wallex.ir/mcp --header "X-API-Key: ${WALLEX_API_KEY}"
```

## [Antigravity CLI](https://antigravity.google/docs/changelog?tab=cli)

```bash
# Public access
agy mcp add wallex --type http https://api.wallex.ir/mcp

# API-key authentication
agy mcp add wallex --type http https://api.wallex.ir/mcp --header "X-API-Key: ${WALLEX_API_KEY}"
```

## [Grok CLI](https://docs.x.ai/build/features/mcp-servers)

```bash
# Public access
grok mcp add --transport http wallex https://api.wallex.ir/mcp

# API-key authentication
grok mcp add --transport http wallex https://api.wallex.ir/mcp --header "X-API-Key: ${WALLEX_API_KEY}"
```

## [Antigravity IDE](https://antigravity.google/docs/mcp)

مسیر `MCP Servers → Manage MCP Servers → View raw config` را باز کنید و یکی از نمونه‌های زیر را با پیکربندی موجود ادغام کنید.

### دسترسی عمومی

```json
{
  "mcpServers": {
    "wallex": {
      "serverUrl": "https://api.wallex.ir/mcp"
    }
  }
}
```

### احراز هویت با کلید API

در فایل پیکربندی محلی خود، مقدار نمونه را با کلید API خود جایگزین کنید:

```json
{
  "mcpServers": {
    "wallex": {
      "serverUrl": "https://api.wallex.ir/mcp",
      "headers": {
        "X-API-Key": "<WALLEX_API_KEY>"
      }
    }
  }
}
```

## [Cursor](https://cursor.com/docs/mcp)

یکی از نمونه‌های زیر را با محتوای فایل `~/.cursor/mcp.json` ادغام کنید.

### دسترسی عمومی

```json
{
  "mcpServers": {
    "wallex": {
      "url": "https://api.wallex.ir/mcp"
    }
  }
}
```

### احراز هویت با کلید API

```json
{
  "mcpServers": {
    "wallex": {
      "url": "https://api.wallex.ir/mcp",
      "headers": {
        "X-API-Key": "${env:WALLEX_API_KEY}"
      }
    }
  }
}
```

## نکات و امنیت

- اگر `wallex` از قبل پیکربندی شده است، به‌جای افزودن ورودی تکراری، ورودی موجود را ویرایش کنید. پس از اعمال تغییرات، کلاینت را دوباره بارگذاری کنید.
- Codex و Cursor کلید API را از محیط فرایند می‌خوانند. آن‌ها را از ترمینالی اجرا کنید که متغیر محیطی در آن تنظیم شده است.
- دستورهای بالا که از `--header` استفاده می‌کنند و نمونهٔ Antigravity IDE، کلید را در پیکربندی محلی ذخیره می‌کنند.
- هرگز کلید API واقعی خود را در مخزن کد ثبت نکنید یا در گفت‌وگو با دستیار قرار ندهید. از کلید API بدون مجوز برداشت استفاده کنید و پیش از اجرای هر سفارش یا انتقال، آن را صریحاً تأیید کنید.
- برای سایر کلاینت‌ها، از Streamable HTTP با نشانی سرور `https://api.wallex.ir/mcp` استفاده کنید. ابزارهای خصوصی به هدر `X-API-Key` نیاز دارند.

[مستندات والکس](https://api.wallex.ir/llm.txt)
