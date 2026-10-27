// Just enough Markdown for model replies: headings, lists, code blocks, bold, italics, inline code.

import React from "react";
import { Box, Text } from "ink";

function Inline({ text }: { text: string }) {
  const parts: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\s][^*]*\*|_[^_\s][^_]*_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const t = m[0];
    if (t.startsWith("**")) parts.push(<Text key={k++} bold>{t.slice(2, -2)}</Text>);
    else if (t.startsWith("`")) parts.push(<Text key={k++} color="cyan">{t.slice(1, -1)}</Text>);
    else parts.push(<Text key={k++} italic>{t.slice(1, -1)}</Text>);
    last = m.index + t.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return <Text>{parts}</Text>;
}

export function Markdown({ text }: { text: string }) {
  const out: React.ReactNode[] = [];
  const lines = text.split("\n");
  let k = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fence = /^\s*```/.exec(line);
    if (fence) {
      const code: string[] = [];
      i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
      out.push(
        <Box key={k++} borderStyle="single" borderLeft borderRight={false} borderTop={false} borderBottom={false} borderColor="gray" paddingLeft={1}>
          <Text color="yellow">{code.join("\n")}</Text>
        </Box>,
      );
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push(<Text key={k++} bold underline={h[1].length === 1}>{h[2]}</Text>);
      continue;
    }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const bullet = /\d/.test(li[2]) ? li[2] : "•";
      out.push(
        <Box key={k++} marginLeft={li[1].length}>
          <Text>{bullet} </Text>
          <Inline text={li[3]} />
        </Box>,
      );
      continue;
    }
    out.push(line.trim() ? <Inline key={k++} text={line} /> : <Text key={k++}> </Text>);
  }
  return <Box flexDirection="column">{out}</Box>;
}
