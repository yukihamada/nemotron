# AI Phone — chat.elio.love

日本語AIとボイスクローンで「電話」できるWebアプリ。

**→ [chat.elio.love](https://chat.elio.love)**

---

## 概要

| 項目 | 内容 |
|------|------|
| LLM | NVIDIA Nemotron Nano 9B v2 (Japanese) / Gemini 2.0 Flash (fallback) |
| TTS | CosyVoice2 zero-shot voice cloning |
| STT | Web Speech API (ブラウザ) + faster-whisper (サーバー) |
| インフラ | Fly.io (Bun) + RunPod Serverless |
| ドメイン | chat.elio.love |

---

## ベンチマーク

**測定日: 2026-02-25 / モデル: Gemini 2.0 Flash (OpenRouter)**

| テスト | レイテンシ | 応答例 |
|--------|-----------|--------|
| 挨拶 | 6,412ms | はーい、こんにちは！何か楽しいことあった？😊 |
| 雑談 | 6,504ms | 最近はね、AIが作った変な俳句を見て笑っちゃった！ |
| 知識 | 6,165ms | 東京都の人口は約1400万人だよ。日本で一番人が多いんだ！ |
| 英語 | 6,156ms | 私の名前はYUKIだよ！よろしくね！ |
| アドバイス | 7,228ms | Progateとかでhtml/css/jsあたりを触ってみるのがオススメだよ ✨ |
| 感情 | 6,340ms | 元気出して！YUKIに話せることあったら、いつでも聞くよ。 |

**成功率: 6/6 (100%) / 平均レイテンシ: 6,468ms**

> 現在 RunPod Nemotron が起動中のため、5秒タイムアウト後に Gemini 2.0 Flash へ自動フォールバック。
> RunPod 復旧後は Nemotron が優先され、レイテンシが改善予定。

---

## アーキテクチャ

```
ブラウザ
  │
  ├─ POST /api/chat ──→ RunPod (Nemotron 9B, 5s timeout)
  │                         │ タイムアウト時
  │                         └→ OpenRouter (Gemini 2.0 Flash)
  │
  ├─ POST /api/tts  ──→ RunPod (CosyVoice2, voice clone)
  ├─ POST /api/stt  ──→ RunPod (faster-whisper large-v3-turbo)
  └─ GET  /api/warmup → RunPod health check
```

**フォールバック戦略:**
1. RunPod が 5 秒以内に応答 → Nemotron を使用
2. タイムアウトまたはエラー → Gemini 2.0 Flash (OpenRouter) に自動切替

---

## 機能

- **音声通話UI** — マイクボタンで話しかけ、AIが返答
- **ボイスクローン** — 自分の声でAIが話す (CosyVoice2 zero-shot)
- **BGM** — カフェ/雨/焚き火/Lo-fi などリアルタイム生成
- **共有リンク** — 声・プロンプト・ゴールをURL1つで共有
- **ウォームアップ表示** — ウェルカム画面でAI起動状態をリアルタイム表示

---

## ローカル起動

```bash
# 環境変数 (.env または export)
export RUNPOD_API_KEY=...
export NEMOTRON_ENDPOINT=...     # RunPod serverless endpoint ID
export COSYVOICE_ENDPOINT=...
export STT_ENDPOINT=...
export OPENROUTER_API_KEY=...    # fallback LLM
export ADMIN_KEY=...

# 起動 (Bun 必須)
bun run server.js
# → http://localhost:8080
```

---

## デプロイ

```bash
flyctl deploy --remote-only
```

シークレット設定:
```bash
flyctl secrets set RUNPOD_API_KEY=... NEMOTRON_ENDPOINT=... \
  COSYVOICE_ENDPOINT=... STT_ENDPOINT=... \
  OPENROUTER_API_KEY=... ADMIN_KEY=... \
  -a nemotron-voice
```

---

## RunPod エンドポイント構成

| エンドポイント | モデル | 推奨GPU |
|---------------|--------|---------|
| NEMOTRON_ENDPOINT | nvidia/NVIDIA-Nemotron-Nano-9B-v2-Japanese | A10G / A100 (24GB+) |
| COSYVOICE_ENDPOINT | CosyVoice2 zero-shot | A10G 以上 |
| STT_ENDPOINT | faster-whisper large-v3-turbo | T4 以上 |

---

## 関連プロジェクト

- [elio.love](https://elio.love) — iPhoneオフラインAIアプリ (ElioChat)
- [chatweb.ai](https://chatweb.ai) — Webチャット (nanobot)
