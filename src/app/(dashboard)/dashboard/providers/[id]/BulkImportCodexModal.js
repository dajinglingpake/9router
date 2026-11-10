"use client";

import { useState } from "react";
import PropTypes from "prop-types";
import { Button, Modal } from "@/shared/components";
import { translate } from "@/i18n/runtime";
import { parseCodexImportText } from "@/shared/utils/codexImport";

const PLACEHOLDER = `{
  "accessToken": "第一个账号的 Token",
  "email": "first@example.com"
}

{
  "accessToken": "第二个账号的 Token",
  "email": "second@example.com"
}`;

export default function BulkImportCodexModal({ isOpen, onClose, onSuccess }) {
  const [jsonText, setJsonText] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [parseError, setParseError] = useState("");
  const [result, setResult] = useState(null);
  const [reading, setReading] = useState(false);
  const [fileNotice, setFileNotice] = useState("");

  const readFiles = async (event) => {
    const files = Array.from(event.target.files || []);
    event.target.value = "";
    if (!files.length) return;
    setParseError(""); setResult(null); setFileNotice(""); setReading(true);
    try {
      if (new Blob([jsonText]).size + files.reduce((total, file) => total + file.size, 0) > 10 * 1024 * 1024) {
        throw new Error("导入内容总大小不能超过 10 MB。");
      }
      const existing = parseCodexImportText(jsonText);
      const contents = await Promise.all(files.map(async file => {
        try {
          const accounts = parseCodexImportText(await file.text());
          if (!accounts.length) throw new Error("文件中没有账号内容。");
          return accounts;
        } catch (error) { throw new Error(`${file.name}：${error.message || "文件读取失败。"}`); }
      }));
      setJsonText([...existing, ...contents.flat()].map(item =>
        JSON.stringify(typeof item === "string" ? { accessToken: item } : item, null, 2)
      ).join("\n\n"));
      setFileNotice(`已添加 ${files.length} 个文件的内容，可继续选择文件追加。`);
    } catch (error) { setParseError(error.message || "文件读取失败。"); }
    finally { setReading(false); }
  };

  const handleClose = () => {
    if (submitting || reading) return;
    setJsonText("");
    setParseError("");
    setResult(null);
    setFileNotice("");
    onClose();
  };

  const handleSubmit = async () => {
    setParseError("");
    setResult(null);

    const trimmed = jsonText.trim();
    if (!trimmed) return;

    let accounts;
    try {
      accounts = parseCodexImportText(trimmed);
    } catch (error) { setParseError(error.message); return; }

    if (!accounts || accounts.length === 0) {
      setParseError(translate("No accounts found in input"));
      return;
    }

    setSubmitting(true);
    try {
      const res = await fetch("/api/oauth/codex/bulk-import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ accounts }),
      });
      const data = await res.json();
      if (!res.ok) {
        setParseError(data?.error || `Request failed: ${res.status}`);
        return;
      }
      setResult(data);
      if (data.success > 0 && typeof onSuccess === "function") {
        onSuccess();
      }
    } catch (err) {
      setParseError(err.message || translate("Request failed"));
    } finally {
      setSubmitting(false);
    }
  };

  const failedItems = result?.results?.filter((r) => !r.ok) || [];

  return (
    <Modal isOpen={isOpen} title="导入 Codex Session / 账号" onClose={handleClose}>
      <div className="flex flex-col gap-4">
        <p className="text-xs text-text-muted">
          直接粘贴一个或多个账号 JSON，每段可换行分隔，无需手动组成数组。也可以一次选择多个 JSON / TXT 文件。
        </p>

        <p className="text-xs text-text-muted">
          登录 ChatGPT 后，打开{" "}
          <a href="https://chatgpt.com/api/auth/session" target="_blank" rel="noopener noreferrer" className="text-primary underline">
            /api/auth/session
          </a>
          ，复制完整 JSON 并粘贴到下方即可导入。原有账号 JSON、JSON 数组和 Access Token 仍可导入。
          完整网页 Session 会一并保存，之后可通过「下载 Session」导出。
          网页 session 不含 refresh token，令牌过期后需要重新复制导入。
        </p>

        <label className="flex flex-col gap-2 text-xs text-text-muted">
          选择 JSON / TXT 文件（支持多选，内容会追加到下方）
          <input type="file" multiple accept=".json,.txt,application/json,text/plain" onChange={readFiles} disabled={submitting || reading}
            className="block w-full text-sm file:mr-3 file:rounded file:border-0 file:bg-sidebar file:px-3 file:py-2 file:text-text-main" />
          {reading && <span role="status">正在读取文件…</span>}
          {fileNotice && <span role="status">{fileNotice}</span>}
        </label>

        <textarea
          className="w-full rounded border border-accent/30 bg-sidebar p-2 text-sm font-mono resize-y min-h-[240px] focus:outline-none focus:ring-1 focus:ring-primary"
          placeholder={PLACEHOLDER}
          value={jsonText}
          onChange={(e) => { setJsonText(e.target.value); setFileNotice(""); }}
          disabled={submitting || reading}
        />

        {parseError && (
          <p className="text-xs text-red-500 break-words">{parseError}</p>
        )}

        {result && (
          <div className="flex flex-col gap-2">
            <div
              className={`text-sm font-medium ${
                result.failed > 0 ? "text-yellow-400" : "text-green-400"
              }`}
            >
              ✓ {result.success} {translate("added")}
              {result.failed > 0 ? `, ✗ ${result.failed} ${translate("failed")}` : ""}
            </div>
            {failedItems.length > 0 && (
              <ul className="rounded border border-accent/20 bg-sidebar/50 p-2 text-xs font-mono max-h-40 overflow-y-auto">
                {failedItems.map((item) => (
                  <li key={item.index} className="text-red-400">
                    [{item.index}] {item.error}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <Button
            onClick={handleSubmit}
            fullWidth
            disabled={submitting || reading || !jsonText.trim()}
          >
            {submitting ? translate("Importing...") : translate("Import All")}
          </Button>
          <Button onClick={handleClose} variant="ghost" fullWidth disabled={submitting || reading}>
            {translate("Close")}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

BulkImportCodexModal.propTypes = {
  isOpen: PropTypes.bool.isRequired,
  onClose: PropTypes.func.isRequired,
  onSuccess: PropTypes.func,
};
