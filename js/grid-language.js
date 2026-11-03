/* Cellular Programming Language: compiler and parser. */
(function (global) {
  "use strict";

  class GridCompileError extends Error {
    constructor(message, line, col, sourceText) {
      super(message);
      this.name = "GridCompileError";
      this.line = line;
      this.col = col;
      this.sourceText = sourceText;
    }
    toString() {
      return (this.line ? `Compilation error at ${this.line}:${this.col}: ` : "Compilation error: ") + this.message;
    }
  }

  function compile(rawSource) {
    const source = String(rawSource ?? "").replace(/\r\n?/g, "\n");
    const lineStarts = [0];
    for (let i = 0; i < source.length; i++) if (source[i] === "\n") lineStarts.push(i + 1);

    function location(index) {
      let lo = 0, hi = lineStarts.length;
      while (lo + 1 < hi) {
        const mid = (lo + hi) >> 1;
        if (lineStarts[mid] <= index) lo = mid;
        else hi = mid;
      }
      return { line: lo + 1, col: index - lineStarts[lo] + 1 };
    }
    function fail(message, index = 0) {
      const p = location(Math.max(0, Math.min(source.length, index)));
      throw new GridCompileError(message, p.line, p.col, source.slice(lineStarts[p.line - 1], source.indexOf("\n", lineStarts[p.line - 1]) < 0 ? source.length : source.indexOf("\n", lineStarts[p.line - 1])));
    }

    // FCBC markers are two independent ordinary comments. They only provide
    // named boundaries for the editor's folding UI; source code between them
    // remains normal executable CPL code. The ordinary comment pass below
    // removes each marker line without touching the enclosed program text.
    const chars = source.split("");

    // Ordinary # comment # syntax remains supported. Replace comment text
    // with spaces so all parsed commands retain their original locations.
    let inComment = false, commentStart = -1;
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i];
      if (!inComment && ch === "#") {
        inComment = true;
        commentStart = i;
        chars[i] = " ";
      } else if (inComment) {
        if (ch === "#") {
          inComment = false;
          chars[i] = " ";
        } else if (ch !== "\n") {
          chars[i] = " ";
        }
      }
    }
    if (inComment) fail("Unterminated comment. Every comment must have a closing '#'.", commentStart);
    const clean = chars.join("");

    let grid = null;
    let executableSeen = false;
    const cleanChars = clean.split("");
    let lineOffset = 0;
    const cleanLines = clean.split("\n");
    for (let lineIndex = 0; lineIndex < cleanLines.length; lineIndex++) {
      const line = cleanLines[lineIndex];
      const trimmed = line.trim();
      const directiveMatch = /^@grid\b/.exec(trimmed);
      if (directiveMatch) {
        const directiveOffset = lineOffset + line.indexOf("@grid");
        if (grid !== null) fail("Duplicate grid initialization. '@grid' can only be declared once.", directiveOffset);
        if (executableSeen) fail("'@grid' must be declared before executable code.", directiveOffset);
        const match = /^\s*@grid\s+(\d+)\s+(\d+)\s*$/.exec(line);
        if (!match) fail("Invalid grid declaration. Expected '@grid <width> <height>' on a single line.", directiveOffset);
        const width = Number(match[1]);
        const height = Number(match[2]);
        if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) {
          fail("Grid width and height must be positive integers.", directiveOffset);
        }
        if (width > 256 || height > 256) {
          fail("Grid dimensions cannot exceed 256 cells in either direction.", directiveOffset);
        }
        grid = { width, height };
        for (let i = 0; i < line.length; i++) cleanChars[lineOffset + i] = " ";
      } else {
        const embeddedDirective = /@grid\b/.exec(line);
        if (embeddedDirective) {
          const directiveOffset = lineOffset + embeddedDirective.index;
          if (grid !== null) fail("Duplicate grid initialization. '@grid' can only be declared once.", directiveOffset);
          if (executableSeen || trimmed) fail("'@grid' must be declared on its own line before executable code.", directiveOffset);
          fail("Invalid grid declaration. Expected '@grid <width> <height>' on a single line.", directiveOffset);
        }
        if (trimmed) executableSeen = true;
      }
      lineOffset += line.length + 1;
    }

    if (grid === null) {
      fail("Missing required grid initialization. Declare '@grid <width> <height>' at the top of the source before any Chain Blocks.", 0);
    }

    const program = cleanChars.join("");
    let last = program.length - 1;
    while (last >= 0 && /\s/.test(program[last])) last--;
    if (last < 0) {
      return { source, grid, chains: [], commandCount: 0 };
    }
    if (program[last] !== ";") {
      fail("Expected ';' to terminate the final chain.", last + 1);
    }

    function parseInteger(value, label, offset) {
      const v = value.trim();
      if (!/^[+-]?\d+$/.test(v)) fail(`${label} must be an integer expression; received '${v || "empty"}'.`, offset);
      const n = Number(v);
      if (!Number.isSafeInteger(n)) fail(`${label} is outside the supported integer range.`, offset);
      return n;
    }

    function splitTopLevel(text, delimiter = ",") {
      const parts = [];
      let start = 0, paren = 0, square = 0, curly = 0, angle = 0;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "<" && text[i + 1] !== ":") angle++;
        else if (ch === ">" && text[i + 1] !== ":" && angle > 0) angle--;
        else if (ch === "(") paren++;
        else if (ch === ")") paren--;
        else if (ch === "[") square++;
        else if (ch === "]") square--;
        else if (ch === "{") curly++;
        else if (ch === "}") curly--;
        else if (ch === delimiter && paren === 0 && square === 0 && curly === 0 && angle === 0) {
          parts.push(text.slice(start, i));
          start = i + 1;
        }
      }
      parts.push(text.slice(start));
      return parts;
    }

    function findMatching(text, start, openChar, closeChar) {
      let depth = 0;
      for (let i = start; i < text.length; i++) {
        if (text[i] === openChar) depth++;
        else if (text[i] === closeChar) {
          depth--;
          if (depth === 0) return i;
        }
      }
      return -1;
    }

    // A numeric argument can be a signed integer literal, a Value Expression,
    // or a left-to-right chain of those operands joined by +, -, and %.
    // Operators are recognized only at the argument's top level, never inside
    // <...>, nested commands, groups, or area-count braces. % applies a
    // positive limiter modulus to the accumulated value on its left.
    function splitIntegerOffsets(text) {
      const parts = [], operators = [];
      let start = 0, paren = 0, square = 0, curly = 0, angle = 0;
      for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        if (ch === "<" && text[i + 1] !== ":") angle++;
        else if (ch === ">" && text[i + 1] !== ":" && angle > 0) angle--;
        else if (ch === "(") paren++;
        else if (ch === ")") paren--;
        else if (ch === "[") square++;
        else if (ch === "]") square--;
        else if (ch === "{") curly++;
        else if (ch === "}") curly--;
        else if ((ch === "+" || ch === "-" || ch === "%") && paren === 0 && square === 0 && curly === 0 && angle === 0) {
          // A sign at the beginning of an operand is unary. This also allows
          // forms such as 4+-2 and 4--2. % is binary and uses the same
          // left-to-right chain as addition and subtraction.
          if (text.slice(start, i).trim()) {
            parts.push(text.slice(start, i));
            operators.push(ch);
            start = i + 1;
          }
        }
      }
      parts.push(text.slice(start));
      return { parts, operators };
    }

    function findCommandInProgram(engine, targetName) {
      if (!engine || !Array.isArray(engine.chains)) return null;
      for (const chain of engine.chains) {
        for (const command of chain.positions || []) {
          if (command.name === targetName) return command;
          if (command.program) {
            const nested = findCommandInProgram(command.program, targetName);
            if (nested) return nested;
          }
          for (const argument of command.args || []) {
            const nested = findCommandInArgument(argument, targetName);
            if (nested) return nested;
          }
        }
      }
      return null;
    }

    function findCommandInArgument(argument, targetName) {
      if (!argument || typeof argument !== "object") return null;
      if (argument.type === "integerExpression") {
        for (const term of argument.terms || []) {
          const nested = findCommandInArgument(term, targetName);
          if (nested) return nested;
        }
      } else if (argument.type === "valueExpression" && argument.expression) {
        const expression = argument.expression;
        if (expression.type === "cmdb") {
          const command = expression.command;
          if (command && command.name === targetName) return command;
          if (command && command.program) {
            const nested = findCommandInProgram(command.program, targetName);
            if (nested) return nested;
          }
          for (const nestedArgument of command && command.args || []) {
            const nested = findCommandInArgument(nestedArgument, targetName);
            if (nested) return nested;
          }
        } else if (expression.type === "areaCount") {
          for (const nestedArgument of expression.args || []) {
            const nested = findCommandInArgument(nestedArgument, targetName);
            if (nested) return nested;
          }
        }
      }
      return null;
    }

    function findEngineTerminationInArgument(argument) {
      if (!argument || typeof argument !== "object") return null;
      if (argument.type === "integerExpression") {
        for (const term of argument.terms || []) {
          const nested = findEngineTerminationInArgument(term);
          if (nested) return nested;
        }
      } else if (argument.type === "valueExpression" && argument.expression) {
        const expression = argument.expression;
        if (expression.type === "cmdb") {
          return findEngineTerminationInCommand(expression.command);
        }
        if (expression.type === "areaCount") {
          for (const nestedArgument of expression.args || []) {
            const nested = findEngineTerminationInArgument(nestedArgument);
            if (nested) return nested;
          }
        }
      }
      return null;
    }

    function findEngineTerminationInCommand(command) {
      if (!command) return null;
      if (command.connectorAfter === "engineTerminate") return command;
      if (command.program) {
        const nested = findEngineTerminationInProgram(command.program);
        if (nested) return nested;
      }
      for (const argument of command.args || []) {
        const nested = findEngineTerminationInArgument(argument);
        if (nested) return nested;
      }
      return null;
    }

    function findEngineTerminationInProgram(engine) {
      if (!engine || !Array.isArray(engine.chains)) return null;
      for (const chain of engine.chains) {
        for (const command of chain.positions || []) {
          const nested = findEngineTerminationInCommand(command);
          if (nested) return nested;
        }
      }
      return null;
    }

    function parseIntegerOrVEAtom(value, label, offset) {
      const v = value.trim();
      const lead = value.length - value.trimStart().length;
      const at = offset + lead;
      if (!v.startsWith("<")) return parseInteger(v, label, at);

      let depth = 0, closing = -1;
      for (let i = 0; i < v.length; i++) {
        if (v[i] === "<" && v[i + 1] !== ":") depth++;
        else if (v[i] === ">" && v[i + 1] !== ":") {
          depth--;
          if (depth === 0) { closing = i; break; }
          if (depth < 0) break;
        }
      }
      if (closing !== v.length - 1 || depth !== 0) {
        fail("A Value Expression must be enclosed by one matching '<' and '>' pair, with no trailing text.", at);
      }
      const body = v.slice(1, -1).trim();
      if (!body) fail("A Value Expression cannot be empty.", at + 1);
      const bodyLead = v.slice(1, -1).length - v.slice(1, -1).trimStart().length;
      const bodyOffset = at + 1 + bodyLead;
      let expression;

      if (body[0] === "{") {
        const close = findMatching(body, 0, "{", "}");
        if (close !== body.length - 1) fail("An area-count Value Expression must use '{sx,sy,ex,ey,b}' with no trailing text.", bodyOffset);
        const rawArgs = body.slice(1, -1);
        const parts = splitTopLevel(rawArgs);
        if (parts.length !== 5) fail(`Area-count Value Expression expects 5 parameters; received ${parts.length}.`, bodyOffset + 1);
        const labels = ["Starting X coordinate", "Starting Y coordinate", "Ending X coordinate", "Ending Y coordinate", "Cell value to count"];
        const args = [];
        let argOffset = bodyOffset + 1;
        for (let i = 0; i < parts.length; i++) {
          args.push(parseIntegerOrVE(parts[i], labels[i], argOffset));
          argOffset += parts[i].length + 1;
        }
        if (typeof args[4] === "number" && args[4] !== 0 && args[4] !== 1) {
          fail("Area-count value must be 0 or 1.", bodyOffset + 1);
        }
        expression = { type: "areaCount", args };
      } else if (body[0] === "[") {
        const command = parsePosition(body, bodyOffset, -1, -1);
        if (command.name !== "group") fail("This Value Expression body starts with '['; provide a complete IGCB CMDB enclosed by matching brackets.", bodyOffset);
        const asynchronous = findCommandInProgram(command.program, "slp");
        if (asynchronous) {
          fail("slp() suspends a live Chain Block instance and cannot be used inside a synchronous Value Expression, including an IGCB.", asynchronous.offset);
        }
        const waitingCall = findCommandInProgram(command.program, "jmpc");
        if (waitingCall) {
          fail("jmpc() suspends its caller until the invoked Chain Block instance exits, so it cannot be used inside a synchronous Value Expression or IGCB.", waitingCall.offset);
        }
        const engineTermination = findEngineTerminationInProgram(command.program);
        if (engineTermination) {
          fail("Engine Termination '&!' cannot be used inside a synchronous Value Expression.", engineTermination.offset);
        }
        expression = { type: "cmdb", command };
      } else {
        const command = parsePosition(body, bodyOffset, -1, -1);
        if (command.name === "jmp") {
          fail("jmp() changes the current Command Block Pointer (CMDP) and has no standalone Boolean value, so it cannot be used as a CMDB Value Expression.", bodyOffset);
        }
        if (command.name === "jmpc") {
          fail("jmpc() suspends its caller until the invoked Chain Block instance exits, so it cannot be used inside a synchronous Value Expression.", bodyOffset);
        }
        if (command.name === "slp") {
          fail("slp() suspends a live Chain Block instance and cannot be used inside a synchronous Value Expression.", bodyOffset);
        }
        const engineTermination = findEngineTerminationInCommand(command);
        if (engineTermination) {
          fail("Engine Termination '&!' cannot be used inside a synchronous Value Expression.", engineTermination.offset);
        }
        expression = { type: "cmdb", command };
      }
      return { type: "valueExpression", expression, offset: at };
    }

    function parseIntegerOrVE(value, label, offset) {
      const raw = String(value);
      const lead = raw.length - raw.trimStart().length;
      const at = offset + lead;
      const text = raw.trim();
      const split = splitIntegerOffsets(text);
      if (split.operators.length) {
        const terms = [];
        let partOffset = at;
        for (let i = 0; i < split.parts.length; i++) {
          const part = split.parts[i];
          if (!part.trim()) fail(`${label} has a missing operand around '${split.operators[Math.max(0, i - 1)] || "operator"}'.`, partOffset);
          terms.push(parseIntegerOrVEAtom(part, label, partOffset));
          partOffset += part.length + 1;
        }
        if (terms.every(term => typeof term === "number")) {
          let result = terms[0];
          for (let i = 0; i < split.operators.length; i++) {
            const operator = split.operators[i];
            const next = terms[i + 1];
            if (operator === "+") result += next;
            else if (operator === "-") result -= next;
            else {
              if (next <= 0) fail(`${label} Limiter Modulus requires a positive integer limit; received '${next}'.`, at);
              result = ((result % next) + next) % next;
            }
            if (!Number.isSafeInteger(result)) fail(`${label} offset expression is outside the supported integer range.`, at);
          }
          return result;
        }
        return { type: "integerExpression", terms, operators: split.operators.slice(), offset: at };
      }
      return parseIntegerOrVEAtom(text, label, at);
    }

    function parsePosition(segment, offset, chainIndex, positionIndex) {
      const lead = /^\s*/.exec(segment)[0].length;
      const text = segment.trim();
      const start = offset + lead;
      if (!text) fail("Empty command block. Add a command after the connector or remove the extra separator.", offset);

      // A square-bracket group is one CMDB in its parent engine. Its contents
      // are compiled recursively as a separate engine with its own chains.
      if (text[0] === "[") {
        const closing = findMatching(text, 0, "[", "]");
        if (closing !== text.length - 1) {
          fail("A grouped engine must be enclosed by one matching '[' and ']' pair, with no trailing text.", start);
        }
        const innerText = text.slice(1, -1);
        const innerProgram = parseEngine(innerText, start + 1, "group");
        if (!innerProgram.chains.length) fail("A grouped engine must contain at least one terminated chain.", start);
        const p = location(start);
        return {
          name: "group", args: [], program: innerProgram,
          chainIndex, positionIndex, line: p.line, col: p.col, offset: start, raw: text
        };
      }

      if (text === "-") {
        const p = location(start);
        return { name: "alwaysFalse", args: [], chainIndex, positionIndex, line: p.line, col: p.col, offset: start, raw: text };
      }
      if (text === "+") {
        const p = location(start);
        return { name: "alwaysTrue", args: [], chainIndex, positionIndex, line: p.line, col: p.col, offset: start, raw: text };
      }
      if (text === "~") {
        const p = location(start);
        return { name: "stepDelay", args: [], chainIndex, positionIndex, line: p.line, col: p.col, offset: start, raw: text };
      }
      if (text.startsWith("-")) fail("The '-' CMDB takes no parameters or additional characters. Use a Chain Connector after it.", start);
      if (text.startsWith("+")) fail("The '+' CMDB takes no parameters or additional characters. Use a Chain Connector after it.", start);
      if (text.startsWith("~")) fail("The '~' Step Delayer CMDB takes no parameters or additional characters. Use a Chain Connector after it.", start);

      const nameMatch = /^([A-Za-z_][A-Za-z_0-9]*)/.exec(text);
      if (!nameMatch) fail("Expected a command block: set(), if(), fill(), copy(), mv(), jmp(), jmpc(), call(), slp(), '+', '-', '~', or a grouped engine '[...]'.", start);
      const name = nameMatch[1];
      if (!["set", "if", "fill", "copy", "mv", "jmp", "jmpc", "call", "slp"].includes(name)) {
        fail(`Unrecognized command block '${name}'. Expected set(), if(), fill(), copy(), mv(), jmp(), jmpc(), call(), slp(), '+', '-', '~', or '[...]'.`, start);
      }
      let cursor = name.length;
      while (/\s/.test(text[cursor] || "")) cursor++;
      if (text[cursor] !== "(") fail(`Expected '(' after '${name}'.`, start + cursor);
      const open = cursor;
      const close = findMatching(text, open, "(", ")");
      if (close < 0) fail(`Expected ')' to close '${name}('.`, start + open);
      const trailing = text.slice(close + 1).trim();
      if (trailing) {
        const extraAt = text.indexOf(trailing, close + 1);
        fail(`Unexpected text '${trailing}' after '${name}()'. Use a Chain Connector to separate code positions.`, start + extraAt);
      }
      const argText = text.slice(open + 1, close);
      const argParts = argText.trim() === "" ? [] : splitTopLevel(argText);
      const expected = ({ jmp: 1, jmpc: 1, call: 1, slp: 1, set: 3, if: 3, fill: 5, copy: 6, mv: 4 })[name];
      if (argParts.length !== expected) {
        fail(`'${name}()' expects ${expected} parameter${expected === 1 ? "" : "s"}; received ${argParts.length}.`, start + open + 1);
      }
      const args = [];
      let argOffset = start + open + 1;
      for (let i = 0; i < argParts.length; i++) {
        const rawArg = argParts[i];
        const labels = {
          jmp: ["Code-position offset"],
          jmpc: ["Chain offset"],
          call: ["Chain offset"],
          slp: ["Sleep duration in milliseconds"],
          set: ["X coordinate", "Y coordinate", "Boolean value"],
          if: ["X coordinate", "Y coordinate", "Expected boolean"],
          fill: ["Starting X coordinate", "Starting Y coordinate", "Ending X coordinate", "Ending Y coordinate", "Boolean value"],
          copy: ["Source starting X coordinate", "Source starting Y coordinate", "Source ending X coordinate", "Source ending Y coordinate", "Destination X coordinate", "Destination Y coordinate"],
          mv: ["Starting X coordinate", "Starting Y coordinate", "Movement offset (0 or 1)", "Movement axis (-1, 0, or 1)"]
        };
        args.push(parseIntegerOrVE(rawArg, labels[name][i], argOffset));
        argOffset += rawArg.length + 1;
      }
      const booleanIndex = name === "fill" ? 4 : (name === "set" || name === "if" || name === "mv" ? 2 : -1);
      if (booleanIndex >= 0 && typeof args[booleanIndex] === "number" && args[booleanIndex] !== 0 && args[booleanIndex] !== 1) {
        const label = name === "mv" ? "MV movement offset" : "Boolean parameter";
        fail(`${label} must be 0 or 1; received '${args[booleanIndex]}'.`, start + open + 1 + argText.lastIndexOf(argParts[booleanIndex].trim()));
      }
      if (name === "mv" && typeof args[3] === "number" && ![-1, 0, 1].includes(args[3])) {
        fail(`MV movement axis must be -1, 0, or 1; received '${args[3]}'.`, start + open + 1 + argText.lastIndexOf(argParts[3].trim()));
      }
      if (name === "slp" && typeof args[0] === "number" && (args[0] < 0 || args[0] > 2147483647)) {
        fail(`slp() sleep duration must be an integer from 0 through 2147483647 milliseconds; received '${args[0]}'.`, start + open + 1);
      }
      const p = location(start);
      return { name, args, chainIndex, positionIndex, line: p.line, col: p.col, offset: start, raw: text };
    }

    function parseChain(body, offset, chainIndex) {
      const segments = [];
      const connectors = [];
      let segmentStart = 0;
      let bracketDepth = 0;
      let valueDepth = 0;

      // Every connector must have a left-hand CMDB. <: redirects this CB's
      // CMDP to its terminator. &! terminates the current engine immediately;
      // any later source positions remain syntactically valid but are not run
      // by the engine that has just been removed.
      for (let i = 0; i < body.length;) {
        if (body[i] === "<" && body[i + 1] !== ":") { valueDepth++; i++; continue; }
        if (body[i] === ">" && body[i + 1] !== ":" && valueDepth > 0) { valueDepth--; i++; continue; }
        if (body[i] === "[") { bracketDepth++; i++; continue; }
        if (body[i] === "]") {
          bracketDepth--;
          if (bracketDepth < 0) fail("Unexpected closing ']' without a matching '['.", offset + i);
          i++;
          continue;
        }
        if (bracketDepth === 0 && valueDepth === 0) {
          let connector = null, width = 0;
          if (body.startsWith("?:", i)) { connector = "branch"; width = 2; }
          else if (body.startsWith(">:", i)) { connector = "reference"; width = 2; }
          else if (body.startsWith("<:", i)) { connector = "return"; width = 2; }
          else if (body.startsWith("&!", i)) { connector = "engineTerminate"; width = 2; }
          else if (body[i] === ":") { connector = "next"; width = 1; }
          if (connector) {
            segments.push({ text: body.slice(segmentStart, i), offset: offset + segmentStart });
            connectors.push(connector);
            i += width;
            segmentStart = i;
            continue;
          }
        }
        i++;
      }
      if (bracketDepth !== 0) fail("Grouped engine is missing a closing ']'.", offset + body.length);
      if (valueDepth !== 0) fail("Value Expression is missing a closing '>'.", offset + body.length);
      segments.push({ text: body.slice(segmentStart), offset: offset + segmentStart });

      // <: may appear as a terminal suffix that redirects CMDP to ';'.
      // &! is allowed after any CMDB. It captures that CMDB's Boolean result
      // and terminates the current engine, so subsequent source positions in
      // that engine are parsed but cannot execute after termination.
      const terminalConnector = connectors[connectors.length - 1];
      const trailingTerminal = !segments[segments.length - 1].text.trim() &&
        (terminalConnector === "return" || terminalConnector === "engineTerminate");
      if (trailingTerminal) segments.pop();

      if (segments.some(part => !part.text.trim())) {
        const emptyIndex = segments.findIndex(part => !part.text.trim());
        const empty = segments[emptyIndex];
        if (emptyIndex === segments.length - 1 && connectors[connectors.length - 1] === "reference") {
          fail("Reference connector '>:' must have a command block after it.", empty.offset);
        }
        fail("Empty command block. Add a command between connectors.", empty.offset);
      }
      if (!segments.length) fail("A chain must contain at least one command block.", offset);
      if (trailingTerminal && connectors.length !== segments.length) {
        fail("Invalid terminal connector placement.", offset + body.length - 2);
      }
      if (!trailingTerminal && connectors.length !== segments.length - 1) {
        fail("Invalid connector placement.", offset + body.length);
      }

      const positions = segments.map((part, index) => {
        const command = parsePosition(part.text, part.offset, chainIndex, index);
        command.connectorAfter = connectors[index] || (index === segments.length - 1 ? "end" : null);
        return command;
      });

      // Match every branch opener with the first later reference that closes
      // it. Nested openers are resolved from the inside out.
      const branchStack = [];
      for (let i = 0; i < positions.length; i++) {
        const command = positions[i];
        if (command.connectorAfter === "branch") {
          const def = { id: `${chainIndex}:branch:${i}`, openerPosition: i, referencePosition: -1 };
          command.branchDef = def;
          branchStack.push(def);
        } else if (command.connectorAfter === "reference") {
          const def = branchStack.pop();
          if (def) {
            def.referencePosition = i;
            command.referenceBranchId = def.id;
          }
        }
      }
      positions.forEach(command => {
        if (command.branchDef) command.branchDef.referencePosition = command.branchDef.referencePosition;
      });
      return { index: chainIndex, positions };
    }

    function parseEngine(code, offset, engineKind = "program") {
      const chains = [];
      let chainStart = 0;
      let chainNumber = 0;
      let bracketDepth = 0;
      let valueDepth = 0;
      for (let i = 0; i < code.length; i++) {
        if (code[i] === "<" && code[i + 1] !== ":") valueDepth++;
        else if (code[i] === ">" && code[i + 1] !== ":" && valueDepth > 0) valueDepth--;
        else if (code[i] === "[") bracketDepth++;
        else if (code[i] === "]") {
          bracketDepth--;
          if (bracketDepth < 0) fail("Unexpected closing ']' without a matching '['.", offset + i);
        } else if (code[i] === ";" && bracketDepth === 0 && valueDepth === 0) {
          const body = code.slice(chainStart, i);
          if (!body.trim()) fail("Empty chain. Remove the extra ';' or add a command before it.", offset + i);
          chains.push(parseChain(body, offset + chainStart, chainNumber));
          chainNumber++;
          chainStart = i + 1;
        }
      }
      if (bracketDepth !== 0) fail("Grouped engine is missing a closing ']'.", offset + code.length);
      if (valueDepth !== 0) fail("Value Expression is missing a closing '>'.", offset + code.length);
      const tail = code.slice(chainStart);
      if (tail.trim()) fail("Expected ';' to terminate the final chain.", offset + chainStart + tail.trimEnd().length - 1);
      if (!chains.length && code.trim()) fail("Expected a terminated chain ending with ';'.", offset);
      return {
        kind: engineKind,
        chains,
        commandCount: chains.reduce((count, chain) => count + chain.positions.length, 0)
      };
    }

    const rootProgram = parseEngine(program, 0, "root");
    const chains = rootProgram.chains;

    const gridCommands = new Set(["set", "if", "fill", "copy", "mv"]);
    function findGridInArgument(argument) {
      if (!argument || typeof argument !== "object") return null;
      if (argument.type === "integerExpression") {
        for (const term of argument.terms) {
          const nested = findGridInArgument(term);
          if (nested) return nested;
        }
        return null;
      }
      if (argument.type !== "valueExpression") return null;
      const expression = argument.expression;
      if (expression.type === "areaCount") return { name: "areaCount", offset: argument.offset };
      if (expression.type === "cmdb") return findGridInCommand(expression.command);
      return null;
    }
    function findGridInCommand(command) {
      if (gridCommands.has(command.name)) return command;
      if (command.name === "group") {
        const nested = findGridCommand(command.program);
        if (nested) return nested;
      }
      for (const argument of command.args || []) {
        const nested = findGridInArgument(argument);
        if (nested) return nested;
      }
      return null;
    }
    function findGridCommand(engine) {
      for (const chain of engine.chains) {
        for (const command of chain.positions) {
          const nested = findGridInCommand(command);
          if (nested) return nested;
        }
      }
      return null;
    }
    const firstGridCommand = findGridCommand(rootProgram);
    if (firstGridCommand && grid === null) {
      fail("Grid is not initialized. Declare '@grid <width> <height>' before using grid commands or grid-based Value Expressions.", firstGridCommand.offset);
    }

    return {
      source,
      grid,
      kind: "root",
      chains,
      commandCount: rootProgram.commandCount
    };
  }

  global.GridLanguage = { compile, GridCompileError };
})(window);
