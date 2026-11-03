/* CPL programmer reference. Sections are ordered by the execution model:
   pointers -> connectors -> CMDBs -> expressions -> source setup -> engine. */
window.CPL_DOCUMENT_DATA = {
  title: "CPL Programmer Reference",
  sections: [
    {
      title: "1. Pointers and Chain Block execution",
      blocks: [
        {
          type: "p",
          text: "CPL execution is controlled by two pointers. Understand these first: CBP selects which Chain Block definition an instance is running, while CMDP selects which CMDB position inside that Chain Block runs next. Every active Chain Block instance owns its own pointer state."
        },
        {
          type: "entry",
          term: "CB — Chain Block",
          paragraphs: [
            "A Chain Block is a sequence of CMDB positions connected by Chain Connectors and ending at a semicolon ;. The source defines CBs in order. The first CB is CBP 0 internally (shown as CBP 1 in the trace), the next is CBP 1 internally, and so on.",
            "A CB definition is not the same thing as a CB instance. An instance is one activation of that definition. The same CB definition can have several independent instances active at once. Removing one instance does not remove the others."
          ]
        },
        {
          type: "entry",
          term: "CBP — Chain Block Pointer",
          paragraphs: [
            "CBP identifies the Chain Block definition selected by the current instance. The instance keeps that CBP while it executes. call(offset) and jmpc(offset) calculate their target from the current CBP plus the supplied relative chain offset. The trace displays CBP using one-based numbering; offsets are relative to the current CBP.",
            "An IGCB has its own internal engine and its own CBP numbering space. Its internal CBP values do not replace the parent engine's CBP."
          ]
        },
        {
          type: "entry",
          term: "CMDP — Command Block Pointer",
          paragraphs: [
            "CMDP identifies the next CMDB position inside the CB selected by CBP. CMDP positions are zero-based. The current instance's connectors normally advance or redirect CMDP; jmp(offset) changes it directly. Other instances have their own CMDPs, even when they execute the same CB definition.",
            "The semicolon ; is the terminal boundary after the final CMDB position. A CMDP redirected to that boundary has reached the CB terminator."
          ],
          code: "@grid 1 1\n+:jmp(-1);"
        },
        {
          type: "h4",
          text: "Instances and scheduling"
        },
        {
          type: "list",
          items: [
            "At Run, the interpreter creates one root instance for every top-level CB. Each instance starts at its CBP and CMDP 0.",
            "The scheduler runs one CMDB step for one runnable instance, then gives another runnable instance a turn. Instances are independent and interleaved; they do not have to wait for a previous chain to finish, but they are not simultaneous CPU threads.",
            "Each instance owns its CMDP, connector/branch state, MV movement reference, pending step delay, sleep state, and any jmpc() wait state. The cellular grid is shared by all instances.",
            "An instance is removed when its CMDP reaches ; or when a connector terminates its path before ;. Only that instance is removed."
          ]
        },
        {
          type: "entry",
          term: "jmp(offset) — move the current CMDP",
          paragraphs: [
            "Changes this instance's CMDP to current CMDP + offset. The destination must be an existing CMDB position in the same CB. jmp() does not activate another instance, and the connector after jmp() is bypassed."
          ],
          code: "@grid 1 1\n+:jmp(-1);"
        },
        {
          type: "entry",
          term: "call(chainOffset) — activate without waiting",
          paragraphs: [
            "Creates a fresh instance of the target CB in the current engine. The target CBP is current CBP + chainOffset and the new CMDP starts at 0. The calling instance continues immediately. call() completes with TRUE without waiting for, or receiving the eventual result of, the new instance."
          ],
          code: "@grid 2 1\ncall(1):set(0,0,1);\nset(1,0,1);"
        },
        {
          type: "entry",
          term: "jmpc(chainOffset) — activate and wait",
          paragraphs: [
            "Creates a fresh instance of the target CB in the current engine and suspends the caller at the jmpc() CMDB. The caller's CMDP stays on jmpc(); other runnable instances continue. The caller does not create a replacement for itself, and it is not removed while waiting.",
            "jmpc() resumes only after the exact instance it created is removed. It returns TRUE if that instance reached the terminal semicolon ;. It returns FALSE if that instance was removed before reaching ;, such as through a false : path or a true >: path.",
            "Returnee <: is a route to the semicolon: it redirects the called instance's CMDP to ;. Therefore a called instance that reaches <: also reaches ;, and its waiting jmpc() receives TRUE. The TRUE result is caused by reaching the terminator, not by <: forwarding the left-hand CMDB's Boolean result.",
            "Nested jmpc() calls suspend each caller in turn. A caller remains alive with its own CBP and CMDP while its child runs. When the child is removed, the caller resumes at the same jmpc() CMDB and routes the child's TRUE/FALSE result through its following connector."
          ],
          code: "@grid 2 1\njmpc(1):set(0,0,1);\njmpc(1):+;\n+;"
        }
      ]
    },
    {
      title: "2. Chain Connectors (CC)",
      blocks: [
        {
          type: "p",
          text: "A Chain Connector (CC) is control syntax between CMDB positions, or a terminal marker at the end of a CB. A CC receives the Boolean result from the CMDB on its left, except where a paired conditional path also supplies control state. It changes the CMDP of the current instance; it does not move another instance's pointer."
        },
        {
          type: "entry",
          term: ": — conditional continuation",
          paragraphs: [
            "Receives the Boolean result of the CMDB immediately to its left. TRUE advances CMDP to the CMDB on the right. FALSE ends this CB instance before its semicolon. This is the ordinary conditional chain connector."
          ],
          code: "@grid 2 1\n+:set(0,0,1);\n-:set(1,0,1);"
        },
        {
          type: "entry",
          term: "?: — Pointer Checker",
          paragraphs: [
            "Opens a checked path and must pair with a later >: in the same CB. It receives the Boolean result of its left-hand CMDB. TRUE enters the checked path and records which >: closes it. FALSE skips the checked path and redirects CMDP to the CMDB immediately after that paired >:. Nested pairs are matched from the inside out."
          ],
          code: "@grid 4 1\nif(0,0,1)?:set(1,0,1)>:set(3,0,1);"
        },
        {
          type: "entry",
          term: ">: — inverted : / reference connector",
          paragraphs: [
            "Without an active ?: pair, >: is the inverted form of :. It receives the Boolean result of the CMDB immediately to its left: FALSE advances to the right-hand CMDB; TRUE ends the current CB instance.",
            "When it is the reference paired with ?:, it also handles the checker's control path. A FALSE result from ?: redirects CMDP to the CMDB after the paired >:. When execution reaches a paired >: from the checked path, the left-hand CMDB's result is evaluated there: TRUE ends the CB; FALSE continues after the reference. Thus >: can receive input from the CMDB on its left or from the paired ?: control route."
          ],
          code: "@grid 2 1\nif(0,0,1)>:set(1,0,1);"
        },
        {
          type: "entry",
          term: "<: — Returnee",
          paragraphs: [
            "Returnee is a terminal CC suffix written after a CMDB. It does not terminate by deleting the instance at <: itself. It immediately redirects the current instance's CMDP to the CB's terminal semicolon ;, skipping any remaining CMDB positions.",
            "Returnee does not forward the left-hand CMDB's TRUE/FALSE result as a separate Returnee value. The CMDB still executes normally, but <: ignores that result for routing and jumps to ; regardless of whether the CMDB returned TRUE or FALSE.",
            "Because <: directs CMDP to ;, the instance completes through the normal terminator path. A jmpc() waiting for that instance therefore detects that ; was reached and returns TRUE."
          ],
          code: "@grid 1 1\nif(0,0,1)<:;"
        },
        {
          type: "entry",
          term: "&! — Engine Termination",
          paragraphs: [
            "Engine Termination is a CC written after a CMDB, for example set(0,0,1)&!set(1,0,1);. It captures the Boolean result of the CMDB immediately to its left, then forcibly terminates the current engine scope and every nested engine beneath it, removing all their active CB instances. It may appear between CMDBs like other connectors; once reached, the engine is terminated immediately, so later CMDBs in that engine do not execute.",
            "When used inside an IGCB, &! terminates only that IGCB engine and its descendants. It cannot access or terminate the parent engine. The waiting parent IGCB receives the captured left-hand Boolean result and routes it through the connector following the [ ... ] CMDB.",
            "When used in the root engine, &! terminates the entire program, including every other root CB instance and all nested engines. There is no parent engine to receive its Boolean result. Source may syntactically follow &!, but it cannot execute because the engine has already been terminated."
          ],
          code: "@grid 1 1\nset(0,0,1)&!;"
        },
        {
          type: "entry",
          term: "; — CB terminator",
          paragraphs: [
            "Terminates the current CB. Reaching ; marks that instance as having completed its CB normally. jmpc() uses this exact condition: TRUE means the invoked instance reached ;; FALSE means it was removed before ;. A CMDB's own FALSE result does not prevent success if the active CC path still reaches ;."
          ],
          code: "@grid 1 1\n-;"
        }
      ]
    },
    {
      title: "3. Command Blocks (CMDB)",
      blocks: [
        {
          type: "p",
          text: "A CMDB (Command Block) is one executable position in a CB. A CMDB may be written as a zero-parameter symbol, a parameterized command, or an IGCB group written in square brackets. Commands are case-sensitive. Parameters are comma-separated. Unless noted otherwise, CMDBs that perform an action return TRUE on success; if() returns the comparison result."
        },
        {
          type: "h4",
          text: "Zero-parameter CMDBs"
        },
        {
          type: "entry",
          term: "+ — always TRUE",
          paragraphs: ["A zero-parameter CMDB that returns TRUE. It performs no grid operation."],
          code: "@grid 1 1\n+;"
        },
        {
          type: "entry",
          term: "- — always FALSE",
          paragraphs: ["A zero-parameter CMDB that returns FALSE. The following CC decides whether the current CB continues or terminates."],
          code: "@grid 1 1\n-;"
        },
        {
          type: "entry",
          term: "~ — Step Delayer",
          paragraphs: [
            "A zero-parameter CMDB. When it executes in a normal CB instance, it holds that instance's CMDP on ~ for one additional interpreter step. On the following turn, CMDP advances past ~ and its TRUE result is routed through the following CC. Other runnable instances can execute during this delay. It is a step delay, not a millisecond timer.",
            "A sequence such as ~:~:~:~:~:~:~: creates repeated CMDP delays. Each ~ delays its own CMDP advancement by one interpreter step. If ~ is evaluated synchronously inside a VE, it produces TRUE but cannot yield the live scheduler or delay a live instance."
          ],
          code: "@grid 1 1\n~:~:~:~:~:~:~:~:~:~;"
        },
        {
          type: "h4",
          text: "IGCB CMDB"
        },
        {
          type: "entry",
          term: "[ ... ] — IGCB (Isolated Group Chain Block)",
          paragraphs: [
            "An IGCB is itself one CMDB. It contains an isolated inner engine made of one or more CBs separated by semicolons. Each inner CB receives its own internal CBP and starts as an independent inner instance. The IGCB has its own CBP namespace; all inner instances still use the same cellular grid as the parent program.",
            "When an IGCB CMDB executes in normal program code, it activates all internal instances and suspends the parent instance at the [ ... ] CMDB. The parent resumes only after every instance and nested engine inside that IGCB has finished or been terminated. Natural completion returns TRUE, even if individual inner CB instances ended early through their own connectors. Other runnable instances outside the waiting parent can continue while the IGCB runs.",
            "If &! is executed inside the IGCB, that IGCB engine and all its descendants are forcibly removed. The parent engine survives, and the IGCB returns the Boolean result of the CMDB immediately to the left of &!. Use call() when you want a fire-and-forget parallel CB instance in the current engine instead of a waiting isolated group."
          ],
          code: "@grid 3 1\n[\n  set(0,0,1);\n  call(1):set(1,0,1);\n  +;\n]:set(2,0,1);"
        },
        {
          type: "h4",
          text: "Grid CMDBs"
        },
        {
          type: "entry",
          term: "set(x, y, b)",
          paragraphs: ["Writes b into cell (x,y). b must evaluate to 0 or 1. Returns TRUE when the write succeeds."],
          code: "@grid 4 3\nset(2,1,1);"
        },
        {
          type: "entry",
          term: "if(x, y, b)",
          paragraphs: ["Compares cell (x,y) with b. Returns TRUE when the cell contains b; otherwise returns FALSE. b must evaluate to 0 or 1. It does not modify the grid."],
          code: "@grid 4 3\nif(2,1,0):set(3,1,1);"
        },
        {
          type: "entry",
          term: "fill(sx, sy, ex, ey, b)",
          paragraphs: ["Fills every cell in the inclusive rectangle with b. b must evaluate to 0 or 1. The two corners may be supplied in either order on either axis; CPL normalizes each axis to its minimum and maximum coordinate."],
          code: "@grid 6 5\nfill(4,3,1,1,1);"
        },
        {
          type: "entry",
          term: "copy(sx, sy, ex, ey, dx, dy)",
          paragraphs: [
            "Copies the inclusive source rectangle to a destination whose top-left cell is (dx,dy). The source corners may be reversed. The destination size is derived from the normalized source rectangle. The source is snapshotted before writing, so overlapping copies use the original source values."
          ],
          code: "@grid 8 6\ncopy(4,3,1,1,0,0);"
        },
        {
          type: "entry",
          term: "mv(sx, sy, b, dr)",
          paragraphs: [
            "Moves the source cell's binary state to an adjacent destination and updates this instance's movement reference. b is the movement offset, not the cell value: 1 adds one to the selected coordinate; 0 subtracts one. dr selects the axis: -1 changes both X and Y, 0 changes X, and 1 changes Y.",
            "The destination receives the source's original value. The source becomes the opposite binary value. The destination's previous value is overwritten; this is not a two-cell swap. Later mv() commands in the same instance continue from the updated destination reference. Each instance has its own movement reference."
          ],
          code: "@grid 6 1\nset(0,0,1):mv(0,0,1,0):mv(0,0,1,0);"
        },
        {
          type: "h4",
          text: "Execution-control CMDBs"
        },
        {
          type: "entry",
          term: "slp(ms)",
          paragraphs: [
            "Suspends only the current CB instance for ms milliseconds. Its CMDP stays on slp() while sleeping. Other runnable instances continue. When the timer expires, slp() completes with TRUE and the following CC is evaluated. ms must be an integer from 0 through 2147483647; slp(0) does not wait.",
            "slp() is asynchronous and cannot be used inside a synchronous Value Expression evaluation."
          ],
          code: "@grid 2 1\nslp(1000):set(0,0,1);\nset(1,0,1);"
        },
        {
          type: "entry",
          term: "jmp(offset)",
          paragraphs: ["Moves the current instance's CMDP to current CMDP + offset. The target must be an existing CMDB position in the same CB. jmp() bypasses its following CC and does not create another instance."],
          code: "@grid 1 1\n+:jmp(-1);"
        },
        {
          type: "entry",
          term: "call(chainOffset)",
          paragraphs: ["Creates a fresh instance of the CB at current CBP + chainOffset. The new instance starts at CMDP 0. The caller immediately continues; call() does not wait for the new instance."],
          code: "@grid 2 1\ncall(1):set(0,0,1);\n+;"
        },
        {
          type: "entry",
          term: "jmpc(chainOffset)",
          paragraphs: ["Creates a fresh instance at current CBP + chainOffset and suspends the caller at jmpc(). When that exact instance reaches ;, jmpc() returns TRUE. If it is removed before ;, jmpc() returns FALSE. The caller's CMDP remains at jmpc() until the result is available. See the pointer section for the full wait/resume behavior."],
          code: "@grid 2 1\njmpc(1):set(0,0,1);\n+;"
        }
      ]
    },
    {
      title: "4. Value Expressions (VE) and integer offsets",
      blocks: [
        {
          type: "p",
          text: "A Value Expression (VE) uses one outer pair of angle brackets < ... > and produces an integer. A VE can be used anywhere a CMDB parameter expects an integer. It is an expression, not a mutable variable. The outer <> accepts either an area-count body { ... } or a CMDB. Since an IGCB is a CMDB, an IGCB can also be placed inside <>."
        },
        {
          type: "entry",
          term: "<CMDB> — Boolean-to-integer VE",
          paragraphs: [
            "Evaluates the contained CMDB and converts its Boolean result to an integer: TRUE becomes 1 and FALSE becomes 0. The CMDB can be a regular command or an IGCB written as [ ... ]. Do not read <[ ... ]> as a separate built-in construct: it is the ordinary VE wrapper < ... > containing an IGCB CMDB [ ... ].",
            "In ordinary program code, an IGCB waits for all of its internal instances and nested engines to finish naturally, then returns TRUE; forced termination through &! returns the left-hand CMDB's Boolean result. Inside a VE, the contained IGCB is evaluated synchronously to obtain one Boolean result and does not interleave with live instances. jmp() has no standalone Boolean result, and jmpc(), slp(), and live Engine Termination (&!) cannot be used inside synchronous VE evaluation."
          ],
          code: "@grid 4 2\nset(<if(0,0,0)>+1,1,1);"
        },
        {
          type: "entry",
          term: "<{sx,sy,ex,ey,b}> — area-count VE",
          paragraphs: [
            "Counts cells whose value equals b in the inclusive rectangle between the two supplied corners and returns the count as an integer. b must be 0 or 1. The rectangle corners may be reversed on either axis. Counting does not modify the grid."
          ],
          code: "@grid 5 5\nfill(0,0,1,1,1);\nset(<{1,1,0,0,1}>-4,4,1);"
        },
        {
          type: "h4",
          text: "Integer offsets and Limiter Modulus accepted by CMDB parameters"
        },
        {
          type: "list",
          items: [
            "Every integer parameter accepts signed integer operands and Value Expressions joined by +, -, and %.",
            "All three operators are evaluated strictly from left to right, without arithmetic precedence. For example, 10-3+2 evaluates to 9; 0+10-2%4 evaluates to 0; and 0+1-1+1%2-2+3-2%3 also evaluates to 0.",
            "Limiter Modulus (%) applies to the accumulated value on its left. The right operand must evaluate to a positive integer N; the result wraps into the range 0 through N-1. For example, 15%10 evaluates to 5, 10%10 evaluates to 0, and -1%5 evaluates to 4. It is a wraparound limiter, not a clamp-to-maximum operation.",
            "The % operator can be repeated or placed between any other offsets. Each one limits the accumulated result at that exact point in the left-to-right chain.",
            "Offsets can be written after a VE's closing >, such as <if(0,0,0)>+2%3. They can also appear inside the parameters of { ... }.",
            "Multiplication, division, decimals, and parenthesized arithmetic are not part of the integer-expression syntax.",
            "Arithmetic does not bypass a parameter's restrictions. set() and fill() still require their Boolean value to be 0 or 1; mv() still requires its movement offset to be 0 or 1 and its axis to be -1, 0, or 1."
          ]
        },
        {
          type: "code",
          text: "@grid 10 4\nset(15%10,0,1);\nset(0+10-2%4,1,1);\nset(-1%10,2,1);\nset(<if(0,0,0)>+15%10,3,1);"
        }
      ]
    },
    {
      title: "5. Required grid directive and source syntax",
      blocks: [
        {
          type: "entry",
          term: "@grid width height",
          paragraphs: [
            "Every CPL source file must contain exactly one @grid directive. Write it on its own line at the top of the source, before executable code. It is required, not optional. Width and height must be whole numbers from 1 through 256. The grid is initialized to zero once when Run starts and is shared by all top-level CB instances, call()/jmpc() instances, and IGCB engines.",
            "Blank lines and comments may appear before @grid. A missing directive, duplicate directive, malformed dimension, or directive after executable code is a compilation error."
          ],
          code: "@grid 20 12"
        },
        {
          type: "h4",
          text: "CB boundaries and separators"
        },
        {
          type: "list",
          items: [
            "A semicolon ; terminates a CB. The parser uses top-level semicolons to separate top-level CB definitions; semicolons inside an IGCB separate that IGCB's internal CBs.",
            "A colon :, ?:, >:, <:, and &! are Chain Connectors, not statement terminators. <: redirects one CB instance's CMDP to ;, while &! terminates the entire current engine scope immediately after capturing the left-hand CMDB result.",
            "Newlines and indentation are for readability. They do not separate CMDBs or terminate a CB.",
            "Every non-empty CB must terminate with ;. Empty CBs are invalid."
          ]
        },
        {
          type: "entry",
          term: "# comment text # — ordinary comment",
          paragraphs: ["An ordinary comment begins with # and ends at the next #. Its contents are ignored by the compiler. It may cross a line break, but it must have a closing #. The sequence ## is an empty comment."],
          code: "@grid 2 1\n# ignored comment #\nset(0,0,1);"
        },
        {
          type: "entry",
          term: "FCBC — Foldable Code Block Comment",
          paragraphs: [
            "FCBC (Foldable Code Block Comment) is an editor-folding convention made from two separate ordinary comments. Put #<Name># and #</Name># on their own lines, using the same name. Each marker line is ignored as a comment, but the code between them remains normal CPL code and executes.",
            "The editor connects the matching named markers into one foldable region. Folding only hides the enclosed lines visually; it does not disable, comment out, or change their execution. FCBC is not a CMDB or CB."
          ],
          code: "@grid 2 1\n#<ActiveCode>#\nset(0,0,1);\n#</ActiveCode>#\nset(1,0,1);"
        }
      ]
    },
    {
      title: "6. How the compiler and interpreter work",
      blocks: [
        {
          type: "h4",
          text: "Compilation"
        },
        {
          type: "list",
          items: [
            "Normalizes line endings and removes ordinary comments, including the two FCBC marker comments, while preserving all source code between FCBC markers and retaining source locations for diagnostics.",
            "Validates the required single @grid directive and its dimensions.",
            "Parses top-level CB definitions and recursively parses IGCB engines, respecting nested brackets, VE angle brackets, and area-count braces.",
            "Parses each CB into ordered CMDB positions, checks command names, parameter counts, integer expressions, and connector placement.",
            "Pairs ?: with its corresponding >: and builds the internal structures used by the interpreter.",
            "If any compilation error occurs, execution does not start and no CMDB runs."
          ]
        },
        {
          type: "h4",
          text: "Interpretation and scheduling"
        },
        {
          type: "list",
          items: [
            "Run initializes the grid to all zeroes and creates a root instance for each top-level CB.",
            "The scheduler selects one runnable instance and evaluates its current CMDB. Integer parameters and VEs are evaluated before the CMDB performs its operation.",
            "The resulting Boolean is passed to the CC after that CMDB. The CC changes the current instance's CMDP. jmp() can change CMDP directly; ~ and slp() temporarily hold CMDP before it advances.",
            "call() creates a new instance and lets its caller continue. jmpc() creates a new instance and suspends its caller until that exact instance reaches ; or is removed before ;.",
            "An IGCB CMDB creates an isolated child engine, starts its internal CB instances, and suspends its parent at the [ ... ] position. The parent resumes with TRUE when the child engine naturally has no remaining instances or nested engines. If &! forcibly terminates that child engine, the parent resumes with the Boolean result of the CMDB immediately to the left of &!.",
            "&! removes every instance in the current engine and all nested engines, but never reaches upward into the parent engine. In the root engine, it ends the entire program. call() remains the existing way to start an independent CB instance without waiting; call() and jmpc() keep their existing behavior.",
            "The run completes when there are no active instances. Stop or a runtime error ends the whole run."
          ]
        },
        {
          type: "p",
          text: "The scheduler is cooperative and single-threaded. 'Independent' means instances have separate pointer and execution state and are interleaved without waiting for another chain to finish; it does not mean simultaneous execution on separate CPU threads."
        }
      ]
    },
    {
      title: "7. Errors, warnings, and debugging",
      blocks: [
        {
          type: "p",
          text: "Compilation errors are found before execution and prevent the program from starting. Runtime errors occur while interpreting and stop the run. Warnings identify suspicious control flow. The IDE reports a source line and column when that information is available."
        },
        {
          type: "h4",
          text: "Compilation errors"
        },
        {
          type: "list",
          items: [
            "Missing, duplicate, or misplaced @grid — declare exactly one @grid width height before executable code.",
            "Invalid grid dimensions — width and height must be whole numbers from 1 through 256.",
            "Unknown CMDB or wrong parameter count — check the case-sensitive command name and its signature.",
            "Malformed CMDB — check parentheses, commas, empty parameters, and unexpected text after a command.",
            "Malformed integer expression — check for a missing operand, unsupported operator, non-positive Limiter Modulus, or unsafe integer value.",
            "Invalid literal value — Boolean parameters must be 0 or 1; mv() axis must be -1, 0, or 1; literal slp() duration must be in range.",
            "Missing semicolon or empty CB — every CB needs a terminal ; and consecutive semicolons cannot define an empty CB.",
            "Invalid CC placement — a connector needs a CMDB on its left; ?: needs a matching >:; terminal <: redirects to ;, while &! terminates its current engine immediately and may be followed by source that will not execute in that engine.",
            "Unmatched delimiter — check (), [], <>, and {}.",
            "Unsupported synchronous VE operation — jmp() needs a live CMDP; jmpc(), slp(), and live Engine Termination (&!) cannot run inside a synchronous VE."
          ]
        },
        {
          type: "h4",
          text: "Runtime errors"
        },
        {
          type: "list",
          items: [
            "Grid coordinate out of bounds — a cell coordinate is outside the declared grid.",
            "Rectangle out of bounds — fill(), the copy source or destination, and area-count VE rectangles must fit the grid. Reversed corners are allowed; out-of-grid coordinates are not.",
            "Invalid dynamic Boolean or selector — a VE produced a value outside the receiving CMDB's allowed values.",
            "MV movement out of bounds — the source or adjacent destination moved outside the grid.",
            "CMDP target out of range — jmp() calculated a target that is not an existing CMDB position in the current CB.",
            "CBP target out of range — call() or jmpc() calculated a chain outside the current engine.",
            "Invalid sleep duration — a dynamic slp() value was negative, non-integer, or greater than 2147483647 milliseconds.",
            "VE evaluation limit — nested evaluation depth exceeded 64 or a synchronous IGCB exceeded 20,000 CMDB evaluations.",
            "jmpc() deadlock — every active instance is waiting for a child through jmpc(), so no runnable instance can finish a wait path.",
            "Invalid Limiter Modulus — a dynamically evaluated modulus limit must be a positive integer.",
            "Integer range exceeded — an offset expression exceeded the supported safe-integer range."
          ]
        },
        {
          type: "h4",
          text: "Debugging pointers and calls"
        },
        {
          type: "list",
          items: [
            "Read the trace prefix CB#n · CBP n · CMDP n to identify the exact active instance and its current CMDB position.",
            "When an instance is delayed by ~ or slp(), its CMDP remains on that CMDB until the delay completes.",
            "When an instance waits at jmpc(), inspect the exact child CB# it created. The caller should remain at its jmpc() CMDP until that child is removed.",
            "A jmpc() result is based on the child reaching ;. A child that executes <: redirects itself to ; and therefore completes successfully; a child terminated before ; returns FALSE."
          ]
        }
      ]
    },
    {
      title: "8. Using the IDE",
      blocks: [
        {
          type: "p",
          text: "Write CPL source in the editor and select Run to compile and execute it. The runner shows the shared grid, execution status, active CBP/CMDP, and execution trace. Source files use the .cpl extension."
        },
        {
          type: "h4",
          text: "Editor tools"
        },
        {
          type: "list",
          items: [
            "Autocomplete suggests CMDBs, CCs, and common syntax. Use Up/Down to select a suggestion, Tab or Enter to insert it, Esc to close the list, or Ctrl/Cmd+Space to open suggestions manually.",
            "Parameter hints show the active CMDB parameter. For the area-count VE, the hint identifies sx, sy, ex, ey, and b while typing inside { ... }.",
            "The Insert bar places common CMDBs and syntax at the caret or over the current selection.",
            "Editor ▾ contains Find, Replace, Go to line, Word Wrap, and Read Only. File ▾ contains file creation, import, rename, save, copy, and export actions."
          ]
        },
        {
          type: "h4",
          text: "Run controls"
        },
        {
          type: "list",
          items: [
            "Run compiles the full source before starting. A compilation error prevents execution.",
            "Pause/Resume pauses or resumes the scheduler. Step advances one interpreter step while paused. Stop ends the run and removes all active instances. Restart begins a fresh run with a newly initialized grid.",
            "Rapid, Fast, Normal, Slow, and Very slow change the wall-clock pace; they do not change CPL pointer or connector semantics.",
            "The trace reports instance IDs, CBP, CMDP, connector decisions, pointer jumps, delays, and call/resume events."
          ]
        },
        {
          type: "h4",
          text: "Shortcuts"
        },
        {
          type: "list",
          items: [
            "Ctrl/Cmd+Enter — Run.",
            "Ctrl/Cmd+F — Find; Ctrl/Cmd+R — Replace; Ctrl/Cmd+G — Go to line.",
            "Ctrl/Cmd+Z — Undo; Ctrl/Cmd+Shift+Z or Ctrl/Cmd+Y — Redo.",
            "Ctrl/Cmd+A — Select all; Ctrl/Cmd+/ — toggle ordinary line comments; Tab / Shift+Tab — indent / outdent."
          ]
        }
      ]
    },
    {
      title: "9. Example programs",
      blocks: [
        {
          type: "entry",
          term: "A. Independent top-level CBs",
          paragraphs: ["Both root instances are activated at Run. The scheduler can give the second CB a turn while the first CB is still checking its sequence of conditions."],
          code: "@grid 1 3\nif(0,0,0):if(0,0,0):if(0,0,0):if(0,0,0):if(0,0,0):if(0,0,0):set(0,0,1);\nset(0,2,1);"
        },
        {
          type: "entry",
          term: "B. Returnee redirects CMDP to ;",
          paragraphs: ["The if() returns FALSE, but <: does not propagate that FALSE as a Returnee result. It redirects CMDP to the terminal semicolon, so the CB instance reaches ;."],
          code: "@grid 1 1\nif(0,0,1)<:;"
        },
        {
          type: "entry",
          term: "C. jmpc() succeeds through Returnee",
          paragraphs: ["The caller waits. The child executes - (FALSE), then <: redirects the child's CMDP to ;. The child reaches the terminator, so jmpc() resumes with TRUE and the caller continues through :."],
          code: "@grid 1 1\njmpc(1):set(0,0,1);\n-<:;"
        },
        {
          type: "entry",
          term: "D. jmpc() receives FALSE after early termination",
          paragraphs: ["The child executes - and then : terminates it before ;. The waiting caller resumes with FALSE, so its following : path is not executed."],
          code: "@grid 1 1\njmpc(1):set(0,0,1);\n-:+;"
        },
        {
          type: "entry",
          term: "E. call() does not wait",
          paragraphs: ["call(1) creates a fresh instance of the next CB. The caller immediately continues to set(0,0,1), while the called instance remains independently scheduled."],
          code: "@grid 2 1\ncall(1):set(0,0,1);\nset(1,0,1);"
        },
        {
          type: "entry",
          term: "F. Nested Engine Termination",
          paragraphs: ["Inside this IGCB, the second internal CB executes set(0,0,1)&!. The child engine and all its internal instances are removed. The parent engine survives, receives TRUE from the left-hand set(), and continues to set(1,0,1)."],
          code: "@grid 2 1\n[\n  +;\n  set(0,0,1)&!;\n]:set(1,0,1);"
        },
        {
          type: "entry",
          term: "G. IGCB waits for its isolated engine",
          paragraphs: ["The square-bracket IGCB is one CMDB in the parent. The parent waits while both inner CB instances run. Once both have exited and the child engine has no nested engines left, the IGCB returns TRUE and the parent continues to set(2,0,1)."],
          code: "@grid 3 1\n[\n  set(0,0,1);\n  set(1,0,1);\n]:set(2,0,1);"
        },
        {
          type: "entry",
          term: "H. CMDB inside a VE",
          paragraphs: ["The outer <> is the VE wrapper. Its body is an IGCB CMDB, so the IGCB's Boolean engine result is converted to 1 or 0. This is not a separate <[]> syntax."],
          code: "@grid 2 1\nset(<[\n  if(0,0,0):+;\n]>,0,1);"
        },
        {
          type: "entry",
          term: "I. Area-count VE with an offset",
          paragraphs: ["The reversed corners still select the same inclusive 2×2 area. Four cells contain 1, so the VE returns 4 and the offset produces X=0."],
          code: "@grid 5 5\nfill(0,0,1,1,1);\nset(<{1,1,0,0,1}>-4,4,1);"
        },
        {
          type: "entry",
          term: "J. Step delay and timed sleep",
          paragraphs: ["Each ~ holds CMDP for one additional interpreter step. slp(500) instead suspends the instance for 500 milliseconds; unrelated instances can run during either delay."],
          code: "@grid 2 1\n~:~:slp(500):set(0,0,1);\nset(1,0,1);"
        },
        {
          type: "entry",
          term: "K. FCBC comment region",
          paragraphs: ["Both set() commands execute. The two named marker comments only connect the enclosed lines into a foldable editor region; folding it does not affect program execution."],
          code: "@grid 2 1\n#<ActiveCode>#\nset(0,0,1);\n#</ActiveCode>#\nset(1,0,1);"
        }
      ]
    }
  ]
};
