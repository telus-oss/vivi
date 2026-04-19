import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { Loader2, X, FileCode2, FilePlus2, FileX2, FileEdit, ChevronRight, ChevronDown, Folder, ArrowLeft, Eye } from "lucide-react";
import * as api from "../lib/api";

interface DiffViewProps { prId: string; prTitle: string; onClose: () => void }
interface FileChange { path: string; type: "added" | "deleted" | "modified" | "renamed"; additions: number; deletions: number }
interface TreeNode { name: string; path: string; children: TreeNode[]; file?: FileChange }
interface FileSection { path: string; file: FileChange; lines: string[] }

function parseDiff(raw: string): { files: FileChange[]; sections: FileSection[] } {
  const allLines = raw.split("\n");
  const files: FileChange[] = [];
  const sections: FileSection[] = [];
  let current: FileChange | null = null;
  let currentLines: string[] = [];
  for (const line of allLines) {
    if (line.startsWith("diff --git")) {
      const match = line.match(/diff --git a\/(.*) b\/(.*)/);
      if (match) {
        if (current) sections.push({ path: current.path, file: current, lines: currentLines });
        current = { path: match[2], type: "modified", additions: 0, deletions: 0 };
        files.push(current);
        currentLines = [line];
      }
    } else if (current) {
      currentLines.push(line);
      if (line.startsWith("new file")) current.type = "added";
      else if (line.startsWith("deleted file")) current.type = "deleted";
      else if (line.startsWith("rename from")) current.type = "renamed";
      else if (line.startsWith("+") && !line.startsWith("+++")) current.additions++;
      else if (line.startsWith("-") && !line.startsWith("---")) current.deletions++;
    }
  }
  if (current) sections.push({ path: current.path, file: current, lines: currentLines });
  files.sort((a, b) => a.path.localeCompare(b.path));
  sections.sort((a, b) => a.path.localeCompare(b.path));
  return { files, sections };
}

function buildTree(files: FileChange[]): TreeNode[] {
  const root: TreeNode[] = [];
  for (const file of files) {
    const parts = file.path.split("/");
    let nodes = root;
    for (let i = 0; i < parts.length; i++) {
      const name = parts[i], path = parts.slice(0, i + 1).join("/"), isFile = i === parts.length - 1;
      let existing = nodes.find((n) => n.name === name);
      if (!existing) { existing = { name, path, children: [], file: isFile ? file : undefined }; nodes.push(existing); }
      nodes = existing.children;
    }
  }
  function collapse(nodes: TreeNode[]): TreeNode[] {
    return nodes.map((node) => {
      while (node.children.length === 1 && !node.file && !node.children[0].file) {
        const child = node.children[0];
        node = { name: `${node.name}/${child.name}`, path: child.path, children: child.children, file: child.file };
      }
      node.children = collapse(node.children);
      return node;
    });
  }
  return collapse(root);
}

function FileIcon({ type }: { type: FileChange["type"] }) {
  const c = "w-3.5 h-3.5 shrink-0";
  if (type === "added") return <FilePlus2 className={`${c} text-green-400`} />;
  if (type === "deleted") return <FileX2 className={`${c} text-red-400`} />;
  return <FileEdit className={`${c} text-yellow-500`} />;
}

function StatBar({ additions, deletions }: { additions: number; deletions: number }) {
  const total = additions + deletions;
  if (!total) return null;
  const boxes = Math.min(5, total), addBoxes = Math.round((additions / total) * boxes);
  return (
    <span className="flex gap-px shrink-0">
      {Array.from({ length: addBoxes }).map((_, i) => <span key={`a${i}`} className="w-[5px] h-[5px] rounded-sm bg-green-400" />)}
      {Array.from({ length: boxes - addBoxes }).map((_, i) => <span key={`d${i}`} className="w-[5px] h-[5px] rounded-sm bg-red-400" />)}
    </span>
  );
}

function TreeNodeView({ node, depth, selectedFile, onSelect, onViewFile }: {
  node: TreeNode; depth: number; selectedFile: string | null; onSelect: (p: string) => void; onViewFile: (p: string) => void;
}) {
  const [expanded, setExpanded] = useState(true);
  const isDir = !node.file, isSelected = node.file && selectedFile === node.path;
  return (
    <>
      <div
        className={`group w-full flex items-center gap-1 py-[3px] text-left text-[12px] leading-tight rounded transition-colors cursor-pointer ${
          isSelected ? "bg-[var(--color-accent-muted)]/20 text-white" : "text-gray-400 hover:text-gray-200 hover:bg-white/[0.04]"
        }`}
        style={{ paddingLeft: `${6 + depth * 22}px`, paddingRight: 6 }}
        onClick={() => { if (isDir) setExpanded(!expanded); else onSelect(node.path); }}
      >
        {isDir ? (expanded ? <ChevronDown className="w-[10px] h-[10px] shrink-0 text-gray-600" /> : <ChevronRight className="w-[10px] h-[10px] shrink-0 text-gray-600" />) : <span className="w-[10px]" />}
        {isDir ? <Folder className="w-3.5 h-3.5 shrink-0 text-blue-400/60" /> : <FileIcon type={node.file!.type} />}
        <span className="truncate min-w-0 flex-1">{node.name}</span>
        {node.file && (
          <>
            <button onClick={(e) => { e.stopPropagation(); onViewFile(node.path); }} className="hidden group-hover:flex items-center p-0.5 rounded text-gray-600 hover:text-gray-300 transition-colors" title="View full file"><Eye className="w-3 h-3" /></button>
            <span className="text-[10px] font-mono shrink-0 text-gray-600 group-hover:hidden">
              {node.file.additions > 0 && <span className="text-green-500">+{node.file.additions}</span>}
              {node.file.additions > 0 && node.file.deletions > 0 && " "}
              {node.file.deletions > 0 && <span className="text-red-500">&minus;{node.file.deletions}</span>}
            </span>
            <StatBar additions={node.file.additions} deletions={node.file.deletions} />
          </>
        )}
      </div>
      {isDir && expanded && node.children.map((child) => (
        <TreeNodeView key={child.path} node={child} depth={depth + 1} selectedFile={selectedFile} onSelect={onSelect} onViewFile={onViewFile} />
      ))}
    </>
  );
}

function useResizable(initial: number, min: number, max: number) {
  const [width, setWidth] = useState(initial);
  const dragging = useRef(false), startX = useRef(0), startW = useRef(0);
  const onMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault(); dragging.current = true; startX.current = e.clientX; startW.current = width;
    const onMove = (ev: MouseEvent) => { if (!dragging.current) return; setWidth(Math.max(min, Math.min(max, startW.current + ev.clientX - startX.current))); };
    const onUp = () => { dragging.current = false; document.removeEventListener("mousemove", onMove); document.removeEventListener("mouseup", onUp); document.body.style.cursor = ""; document.body.style.userSelect = ""; };
    document.addEventListener("mousemove", onMove); document.addEventListener("mouseup", onUp);
    document.body.style.cursor = "col-resize"; document.body.style.userSelect = "none";
  }, [width, min, max]);
  return { width, onMouseDown };
}

function lineType(line: string): string {
  if (line.startsWith("diff ")) return "file";
  if (line.startsWith("+++") || line.startsWith("---")) return "meta";
  if (line.startsWith("@@")) return "hunk";
  if (line.startsWith("+")) return "add";
  if (line.startsWith("-")) return "del";
  return "ctx";
}

const LINE_BG: Record<string, string> = { add: "bg-green-500/[0.06]", del: "bg-red-500/[0.06]", hunk: "bg-blue-500/[0.06]", file: "", meta: "", ctx: "" };
const LINE_COLOR: Record<string, string> = { add: "text-green-400", del: "text-red-400", hunk: "text-blue-400 italic", file: "text-gray-600", meta: "text-gray-600 font-bold", ctx: "text-gray-500" };

function DiffSection({ section, onViewFile }: { section: FileSection; onViewFile: (p: string) => void }) {
  return (
    <div>
      <div className="sticky top-0 z-10 flex items-center gap-2 px-3 py-1.5 bg-[#161b22] border-t border-b border-[var(--color-border)] shadow-[0_1px_3px_rgba(0,0,0,0.3)]">
        <FileIcon type={section.file.type} />
        <span className="text-[12px] font-semibold text-gray-200 truncate min-w-0">{section.path}</span>
        {section.file.type === "added" && <span className="text-green-400 text-[10px] shrink-0">NEW</span>}
        {section.file.type === "deleted" && <span className="text-red-400 text-[10px] shrink-0">DELETED</span>}
        <span className="text-[10px] text-gray-600 shrink-0">
          {section.file.additions > 0 && <span className="text-green-500">+{section.file.additions}</span>}
          {section.file.additions > 0 && section.file.deletions > 0 && " "}
          {section.file.deletions > 0 && <span className="text-red-500">&minus;{section.file.deletions}</span>}
        </span>
        <button onClick={() => onViewFile(section.path)} className="ml-auto shrink-0 text-[10px] text-gray-600 hover:text-gray-400 transition-colors">View file</button>
      </div>
      <div className="overflow-x-auto">
        {section.lines.filter((l) => lineType(l) !== "file").map((line, i) => {
          const t = lineType(line);
          return (
            <div key={i} className={`flex ${LINE_BG[t]}`}>
              <span className="shrink-0 w-10 text-right pr-2 text-[11px] text-gray-700 select-none border-r border-[var(--color-border)]/50 opacity-50 font-mono leading-[20px]">&nbsp;</span>
              <span className={`pl-3 pr-3 whitespace-pre font-mono text-[12px] leading-[20px] ${LINE_COLOR[t]}`}>{line || "\u00a0"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FileViewer({ prId, filePath, fileType, onBack }: { prId: string; filePath: string; fileType: FileChange["type"]; onBack: () => void }) {
  const [content, setContent] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => { setLoading(true); setError(null); setContent(null); api.getPrFile(prId, filePath).then((r) => setContent(r.content)).catch((e) => setError(e.message)).finally(() => setLoading(false)); }, [prId, filePath]);
  const lines = useMemo(() => content?.split("\n") ?? [], [content]);
  return (
    <div className="flex flex-col flex-1 min-w-0">
      <div className="flex items-center gap-2 px-3 py-1.5 bg-[var(--color-surface-raised)] border-b border-[var(--color-border)] min-h-[32px] shrink-0">
        <button onClick={onBack} className="flex items-center gap-1 text-[11px] text-gray-500 hover:text-gray-300 transition-colors"><ArrowLeft className="w-3 h-3" />Diff</button>
        <span className="text-gray-700">|</span>
        <FileIcon type={fileType} />
        <span className="text-xs font-mono text-gray-300 truncate min-w-0">{filePath}</span>
        <span className="text-[10px] text-gray-600 shrink-0 ml-auto">{lines.length} lines</span>
      </div>
      {loading && <div className="flex items-center justify-center py-12 text-gray-500"><Loader2 className="w-5 h-5 animate-spin mr-2" />Loading file...</div>}
      {error && <div className="m-3 px-3 py-2 text-xs bg-red-500/10 border border-red-500/30 rounded text-red-400">{error}</div>}
      {content !== null && !loading && (
        <div className="flex-1 overflow-auto min-w-0">
          {lines.map((line, i) => (
            <div key={i} className="flex">
              <span className="shrink-0 w-10 text-right pr-2 text-[11px] text-gray-700 select-none border-r border-[var(--color-border)]/50 opacity-50 font-mono leading-[20px]">{i + 1}</span>
              <span className="pl-3 pr-3 whitespace-pre font-mono text-[12px] leading-[20px] text-gray-400">{line || "\u00a0"}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function DiffView({ prId, prTitle, onClose }: DiffViewProps) {
  const [diff, setDiff] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [selectedFile, setSelectedFile] = useState<string | null>(null);
  const [viewingFile, setViewingFile] = useState<string | null>(null);
  const sectionRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const { width: treeWidth, onMouseDown } = useResizable(200, 120, 400);

  useEffect(() => { setLoading(true); setError(null); api.getPrDiff(prId).then((r) => setDiff(r.diff)).catch((e) => setError(e.message)).finally(() => setLoading(false)); }, [prId]);

  const { files, sections } = useMemo(() => diff ? parseDiff(diff) : { files: [], sections: [] }, [diff]);
  const tree = useMemo(() => buildTree(files), [files]);
  const fileMap = useMemo(() => new Map(files.map((f) => [f.path, f])), [files]);
  const totalAdd = files.reduce((s, f) => s + f.additions, 0);
  const totalDel = files.reduce((s, f) => s + f.deletions, 0);

  const scrollToFile = useCallback((path: string) => { setSelectedFile(path); setViewingFile(null); sectionRefs.current.get(path)?.scrollIntoView({ behavior: "smooth", block: "start" }); }, []);
  const viewFile = useCallback((path: string) => { setSelectedFile(path); setViewingFile(path); }, []);
  const viewingFileType = viewingFile ? fileMap.get(viewingFile)?.type ?? "modified" : "modified";

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-2.5 px-3 py-1.5 bg-[var(--color-surface-raised)] border-b border-[var(--color-border)] min-h-[36px] shrink-0">
        <FileCode2 className="w-3.5 h-3.5 text-purple-400 shrink-0" />
        <span className="text-xs font-semibold truncate min-w-0">{prTitle}</span>
        <span className="text-[10px] text-gray-600 shrink-0">{files.length} file{files.length !== 1 ? "s" : ""}</span>
        <span className="text-[10px] shrink-0"><span className="text-green-500 font-semibold">+{totalAdd}</span> <span className="text-red-500 font-semibold">&minus;{totalDel}</span></span>
        <span className="flex-1" />
        <button onClick={onClose} className="p-1 text-gray-600 hover:text-gray-400 rounded transition-colors" title="Close diff"><X className="w-3.5 h-3.5" /></button>
      </div>
      {loading && <div className="flex items-center justify-center py-12 text-gray-500"><Loader2 className="w-5 h-5 animate-spin mr-2" />Loading diff...</div>}
      {error && <div className="m-3 px-3 py-2 text-xs bg-red-500/10 border border-red-500/30 rounded text-red-400">{error}</div>}
      {diff !== null && !loading && (
        <div className="flex flex-1 overflow-hidden">
          <div className="shrink-0 border-r border-[var(--color-border)] flex flex-col overflow-hidden" style={{ width: treeWidth }}>
            <div className="px-2.5 pt-2.5 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-gray-600 shrink-0">Changed files</div>
            <div className="flex-1 overflow-y-auto">
              {tree.map((n) => <TreeNodeView key={n.path} node={n} depth={0} selectedFile={selectedFile} onSelect={scrollToFile} onViewFile={viewFile} />)}
            </div>
          </div>
          <div onMouseDown={onMouseDown} className="w-[3px] shrink-0 cursor-col-resize hover:bg-[var(--color-accent)]/40 active:bg-[var(--color-accent)]/60 transition-colors" />
          {viewingFile ? (
            <FileViewer prId={prId} filePath={viewingFile} fileType={viewingFileType} onBack={() => setViewingFile(null)} />
          ) : (
            <div className="flex-1 overflow-auto min-w-0">
              {sections.map((sec) => (
                <div key={sec.path} ref={(el) => { if (el) sectionRefs.current.set(sec.path, el); }}>
                  <DiffSection section={sec} onViewFile={viewFile} />
                </div>
              ))}
            </div>
          )}
        </div>
      )}
      {diff !== null && diff.length === 0 && !loading && <div className="py-8 text-center text-gray-500 text-sm">No changes in diff.</div>}
    </div>
  );
}
