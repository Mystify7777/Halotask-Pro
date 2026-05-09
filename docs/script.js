const {
  Document, Packer, Paragraph, TextRun, Table, TableRow, TableCell,
  HeadingLevel, AlignmentType, BorderStyle, WidthType, ShadingType,
  LevelFormat, PageNumber, PageBreak, TabStopType, TabStopPosition
} = require('docx');
const fs = require('fs');

const COLORS = {
  primary: '1E3A5F',
  accent: '2E86C1',
  disaster: 'C0392B',
  warning: 'E67E22',
  good: '1E8449',
  lightBlue: 'D6EAF8',
  lightRed: 'FDEDEC',
  lightOrange: 'FEF9E7',
  lightGreen: 'EAFAF1',
  lightGray: 'F2F3F4',
  medGray: 'BDC3C7',
  white: 'FFFFFF',
  darkText: '1A1A2E',
};

const border = { style: BorderStyle.SINGLE, size: 1, color: COLORS.medGray };
const borders = { top: border, bottom: border, left: border, right: border };
const noBorder = { style: BorderStyle.NONE, size: 0, color: 'FFFFFF' };
const noBorders = { top: noBorder, bottom: noBorder, left: noBorder, right: noBorder };

function h1(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_1,
    spacing: { before: 360, after: 160 },
    children: [new TextRun({ text, font: 'Arial', size: 36, bold: true, color: COLORS.primary })]
  });
}

function h2(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_2,
    spacing: { before: 280, after: 120 },
    border: { bottom: { style: BorderStyle.SINGLE, size: 4, color: COLORS.accent, space: 1 } },
    children: [new TextRun({ text, font: 'Arial', size: 28, bold: true, color: COLORS.accent })]
  });
}

function h3(text) {
  return new Paragraph({
    heading: HeadingLevel.HEADING_3,
    spacing: { before: 200, after: 80 },
    children: [new TextRun({ text, font: 'Arial', size: 24, bold: true, color: COLORS.primary })]
  });
}

function body(text, opts = {}) {
  return new Paragraph({
    spacing: { before: 60, after: 60 },
    children: [new TextRun({ text, font: 'Arial', size: 22, color: COLORS.darkText, ...opts })]
  });
}

function bullet(text, level = 0) {
  return new Paragraph({
    numbering: { reference: 'bullets', level },
    spacing: { before: 40, after: 40 },
    children: [new TextRun({ text, font: 'Arial', size: 22, color: COLORS.darkText })]
  });
}

function codeLine(text) {
  return new Paragraph({
    spacing: { before: 20, after: 20 },
    shading: { fill: '1E1E2E', type: ShadingType.CLEAR },
    indent: { left: 360 },
    children: [new TextRun({ text, font: 'Courier New', size: 18, color: 'A8D8A8' })]
  });
}

function spacer(lines = 1) {
  return new Paragraph({ spacing: { before: 0, after: lines * 120 }, children: [new TextRun('')] });
}

function badgeRow(label, color, fill, description) {
  return new TableRow({
    children: [
      new TableCell({
        width: { size: 1400, type: WidthType.DXA },
        borders,
        shading: { fill, type: ShadingType.CLEAR },
        margins: { top: 60, bottom: 60, left: 120, right: 120 },
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: label, font: 'Arial', size: 20, bold: true, color })]
        })]
      }),
      new TableCell({
        width: { size: 7960, type: WidthType.DXA },
        borders,
        margins: { top: 60, bottom: 60, left: 120, right: 120 },
        children: [new Paragraph({
          children: [new TextRun({ text: description, font: 'Arial', size: 20, color: COLORS.darkText })]
        })]
      })
    ]
  });
}

function priorityTable(rows) {
  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [1400, 7960],
    rows: rows.map(([label, color, fill, text]) => badgeRow(label, color, fill, text))
  });
}

function fileCard(filename, phase, items) {
  const phaseColor = phase === 'P1' ? COLORS.disaster : phase === 'P2' ? COLORS.warning : COLORS.accent;
  const rows = items.map(([badge, badgeColor, badgeFill, text]) =>
    new TableRow({
      children: [
        new TableCell({
          width: { size: 1400, type: WidthType.DXA },
          borders,
          shading: { fill: badgeFill, type: ShadingType.CLEAR },
          margins: { top: 60, bottom: 60, left: 120, right: 120 },
          children: [new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: badge, font: 'Arial', size: 18, bold: true, color: badgeColor })]
          })]
        }),
        new TableCell({
          width: { size: 7960, type: WidthType.DXA },
          borders,
          margins: { top: 60, bottom: 60, left: 120, right: 120 },
          children: [new Paragraph({
            children: [new TextRun({ text, font: 'Arial', size: 20, color: COLORS.darkText })]
          })]
        })
      ]
    })
  );

  // Header row
  const headerRow = new TableRow({
    children: [
      new TableCell({
        width: { size: 1400, type: WidthType.DXA },
        borders,
        shading: { fill: phaseColor, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({
          alignment: AlignmentType.CENTER,
          children: [new TextRun({ text: phase, font: 'Arial', size: 22, bold: true, color: COLORS.white })]
        })]
      }),
      new TableCell({
        width: { size: 7960, type: WidthType.DXA },
        borders,
        shading: { fill: COLORS.lightBlue, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({
          children: [new TextRun({ text: filename, font: 'Courier New', size: 22, bold: true, color: COLORS.primary })]
        })]
      })
    ]
  });

  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [1400, 7960],
    rows: [headerRow, ...rows]
  });
}

function summaryTable() {
  const headerRow = new TableRow({
    children: [
      new TableCell({
        width: { size: 2800, type: WidthType.DXA }, borders,
        shading: { fill: COLORS.primary, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'File', font: 'Arial', size: 22, bold: true, color: COLORS.white })] })]
      }),
      new TableCell({
        width: { size: 1200, type: WidthType.DXA }, borders,
        shading: { fill: COLORS.primary, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Phase', font: 'Arial', size: 22, bold: true, color: COLORS.white })] })]
      }),
      new TableCell({
        width: { size: 1200, type: WidthType.DXA }, borders,
        shading: { fill: COLORS.primary, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '🔴 Critical', font: 'Arial', size: 22, bold: true, color: COLORS.white })] })]
      }),
      new TableCell({
        width: { size: 1200, type: WidthType.DXA }, borders,
        shading: { fill: COLORS.primary, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '⚠️ Improve', font: 'Arial', size: 22, bold: true, color: COLORS.white })] })]
      }),
      new TableCell({
        width: { size: 2960, type: WidthType.DXA }, borders,
        shading: { fill: COLORS.primary, type: ShadingType.CLEAR },
        margins: { top: 80, bottom: 80, left: 120, right: 120 },
        children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Est. Effort', font: 'Arial', size: 22, bold: true, color: COLORS.white })] })]
      }),
    ]
  });

  const data = [
    ['server.ts', 'P1', '2', '2', '1–2 hours'],
    ['app.ts', 'P1', '1', '2', '1 hour'],
    ['config/db.ts', 'P2', '1', '3', '2–3 hours'],
    ['User.model.ts', 'P1', '1', '3', '1–2 hours'],
    ['Task.model.ts', 'P1', '1', '2', '1–2 hours'],
    ['auth.middleware.ts', 'P1', '1', '2', '1 hour'],
    ['auth.controller.ts', 'P1', '3', '4', '4–6 hours'],
    ['task.controller.ts', 'P1', '1', '3', '2–3 hours'],
    ['routes/', 'P2', '1', '2', '2–3 hours'],
    ['express.d.ts', 'P2', '1', '0', '30 min'],
    ['tests/', 'P2', '0', '3', '3–4 hours'],
  ];

  const dataRows = data.map(([file, phase, critical, improve, effort], i) => {
    const fill = i % 2 === 0 ? COLORS.white : COLORS.lightGray;
    const phaseColor = phase === 'P1' ? COLORS.lightRed : COLORS.lightOrange;
    const phaseText = phase === 'P1' ? COLORS.disaster : COLORS.warning;
    return new TableRow({
      children: [
        new TableCell({ width: { size: 2800, type: WidthType.DXA }, borders, shading: { fill, type: ShadingType.CLEAR }, margins: { top: 60, bottom: 60, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: file, font: 'Courier New', size: 20, color: COLORS.primary })] })] }),
        new TableCell({ width: { size: 1200, type: WidthType.DXA }, borders, shading: { fill: phaseColor, type: ShadingType.CLEAR }, margins: { top: 60, bottom: 60, left: 120, right: 120 }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: phase, font: 'Arial', size: 20, bold: true, color: phaseText })] })] }),
        new TableCell({ width: { size: 1200, type: WidthType.DXA }, borders, shading: { fill, type: ShadingType.CLEAR }, margins: { top: 60, bottom: 60, left: 120, right: 120 }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: critical, font: 'Arial', size: 20, color: critical === '0' ? COLORS.good : COLORS.disaster })] })] }),
        new TableCell({ width: { size: 1200, type: WidthType.DXA }, borders, shading: { fill, type: ShadingType.CLEAR }, margins: { top: 60, bottom: 60, left: 120, right: 120 }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: improve, font: 'Arial', size: 20, color: COLORS.warning })] })] }),
        new TableCell({ width: { size: 2960, type: WidthType.DXA }, borders, shading: { fill, type: ShadingType.CLEAR }, margins: { top: 60, bottom: 60, left: 120, right: 120 }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: effort, font: 'Arial', size: 20, color: COLORS.darkText })] })] }),
      ]
    });
  });

  return new Table({
    width: { size: 9360, type: WidthType.DXA },
    columnWidths: [2800, 1200, 1200, 1200, 2960],
    rows: [headerRow, ...dataRows]
  });
}

const doc = new Document({
  numbering: {
    config: [
      {
        reference: 'bullets',
        levels: [
          { level: 0, format: LevelFormat.BULLET, text: '\u2022', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 260 } } } },
          { level: 1, format: LevelFormat.BULLET, text: '\u25E6', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 900, hanging: 260 } } } },
        ]
      },
      {
        reference: 'numbers',
        levels: [
          { level: 0, format: LevelFormat.DECIMAL, text: '%1.', alignment: AlignmentType.LEFT, style: { paragraph: { indent: { left: 540, hanging: 260 } } } },
        ]
      }
    ]
  },
  styles: {
    default: { document: { run: { font: 'Arial', size: 22 } } },
    paragraphStyles: [
      { id: 'Heading1', name: 'Heading 1', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 36, bold: true, font: 'Arial' }, paragraph: { spacing: { before: 360, after: 160 }, outlineLevel: 0 } },
      { id: 'Heading2', name: 'Heading 2', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 28, bold: true, font: 'Arial' }, paragraph: { spacing: { before: 280, after: 120 }, outlineLevel: 1 } },
      { id: 'Heading3', name: 'Heading 3', basedOn: 'Normal', next: 'Normal', quickFormat: true, run: { size: 24, bold: true, font: 'Arial' }, paragraph: { spacing: { before: 200, after: 80 }, outlineLevel: 2 } },
    ]
  },
  sections: [{
    properties: {
      page: {
        size: { width: 12240, height: 15840 },
        margin: { top: 1440, right: 1440, bottom: 1440, left: 1440 }
      }
    },
    children: [
      // TITLE PAGE
      spacer(3),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 120 },
        children: [new TextRun({ text: 'HALOTASK PRO', font: 'Arial', size: 52, bold: true, color: COLORS.primary })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 80 },
        children: [new TextRun({ text: 'Server-Side Upgrade Plan', font: 'Arial', size: 36, color: COLORS.accent })]
      }),
      new Paragraph({
        alignment: AlignmentType.CENTER,
        border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: COLORS.accent, space: 1 } },
        spacing: { before: 0, after: 320 },
        children: [new TextRun({ text: 'halotasks-server  \u2022  Code Review v1.0  \u2022  May 2026', font: 'Arial', size: 22, color: COLORS.medGray })]
      }),
      spacer(1),

      // LEGEND
      new Paragraph({
        alignment: AlignmentType.CENTER,
        spacing: { before: 0, after: 80 },
        children: [new TextRun({ text: 'HOW TO READ THIS DOCUMENT', font: 'Arial', size: 22, bold: true, color: COLORS.primary })]
      }),
      priorityTable([
        ['P1  CRITICAL', COLORS.white, COLORS.disaster, 'Must fix before any production deployment. Security vulnerabilities, data loss risks, or silent failure modes.'],
        ['P2  IMPROVE', COLORS.darkText, COLORS.warning, 'Important quality, reliability, or maintainability improvements. Should be done in next sprint.'],
        ['P3  POLISH', COLORS.darkText, COLORS.accent, 'Nice-to-have improvements for developer experience, performance, or future-proofing.'],
      ]),
      spacer(2),
      new Paragraph({ children: [new PageBreak()] }),

      // SECTION 1: EXECUTIVE SUMMARY
      h1('1. Executive Summary'),
      body('The Halotask Pro server is architecturally sound and shows real production awareness \u2014 the DNS fallback in db.ts, the dual-transport email system, and the comprehensive test suite are all signs of a developer who has felt real-world pain. However, several issues must be resolved before this can be considered production-ready.'),
      spacer(1),
      body('Three categories of risk were identified:', { bold: true }),
      bullet('Security risks: Math.random() used for password reset tokens; reset codes logged to console in production; JWT configuration leaked to clients in error messages.'),
      bullet('Reliability risks: No graceful shutdown; no startup crash handler; CORS wildcard fallback when CLIENT_ORIGIN is missing; NaN expiry on bad RESET_TOKEN_TTL_MINUTES env value.'),
      bullet('Data integrity risks: No ObjectId validation on task routes; empty string titles accepted; no tag or field length constraints; no pagination on getTasks.'),
      spacer(1),
      body('Estimated total effort to address all P1 issues: 12\u201318 hours of focused engineering work.'),
      spacer(1),

      // SUMMARY TABLE
      h2('At-a-Glance File Status'),
      summaryTable(),
      spacer(1),
      new Paragraph({ children: [new PageBreak()] }),

      // SECTION 2: PHASE 1
      h1('2. Phase 1 \u2014 Critical Fixes (Do Before Deploy)'),
      body('These issues represent security vulnerabilities, silent failure modes, or data corruption risks. None of them require architectural changes \u2014 most are 5-15 line fixes.'),
      spacer(1),

      // server.ts
      h2('2.1  server.ts'),
      fileCard('halotasks-server/src/server.ts', 'P1', [
        ['\uD83D\uDD34 FIX', COLORS.white, COLORS.disaster, 'Add a .catch() handler to the startServer() call so unhandled startup failures exit with process.exit(1) and a clear error log.'],
        ['\uD83D\uDD34 FIX', COLORS.white, COLORS.disaster, 'Add SIGTERM / SIGINT graceful shutdown handlers that close the HTTP server and disconnect Mongoose before exiting.'],
      ]),
      spacer(1),
      body('Recommended replacement for the startup call:', { bold: true }),
      codeLine('startServer().catch((err) => {'),
      codeLine('  console.error("[Fatal] Startup failed:", err);'),
      codeLine('  process.exit(1);'),
      codeLine('});'),
      spacer(1),
      body('Graceful shutdown pattern:', { bold: true }),
      codeLine('const shutdown = async (signal: string) => {'),
      codeLine('  console.log(`[Server] ${signal} received, shutting down...`);'),
      codeLine('  server.close(async () => {'),
      codeLine('    await mongoose.disconnect();'),
      codeLine('    process.exit(0);'),
      codeLine('  });'),
      codeLine('};'),
      codeLine('process.on("SIGTERM", () => shutdown("SIGTERM"));'),
      codeLine('process.on("SIGINT",  () => shutdown("SIGINT"));'),
      spacer(1),

      // app.ts
      h2('2.2  app.ts'),
      fileCard('halotasks-server/src/app.ts', 'P1', [
        ['\uD83D\uDD34 FIX', COLORS.white, COLORS.disaster, 'Replace the CORS fallback of true (which allows all origins) with a specific dev URL: origin: process.env.CLIENT_ORIGIN ?? "http://localhost:5173"'],
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'Add an explicit body size limit to express.json(): express.json({ limit: "10kb" })'],
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'Add a comment above the 404 handler noting it is terminal \u2014 no middleware should be registered after it.'],
      ]),
      spacer(1),

      // User & Task models
      h2('2.3  User.model.ts & Task.model.ts'),
      fileCard('halotasks-server/src/models/', 'P1', [
        ['\uD83D\uDD34 FIX', COLORS.white, COLORS.disaster, 'Add minlength: 1 to the title field in Task.model.ts. required: true alone allows empty strings.'],
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'Add validate constraints on the tags array: maximum array length (e.g. 20) and maximum per-tag string length (e.g. 50 chars).'],
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'Add min: 0 to estimatedMinutes to block negative values.'],
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'Add an index on resetPasswordExpiresAt in User.model.ts for efficient token cleanup queries.'],
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'Export IUser and ITask TypeScript interfaces (or use InferSchemaType) for type safety in controllers.'],
      ]),
      spacer(1),

      // auth.middleware.ts
      h2('2.4  auth.middleware.ts'),
      fileCard('halotasks-server/src/middleware/auth.middleware.ts', 'P1', [
        ['\uD83D\uDD34 FIX', COLORS.white, COLORS.disaster, 'Replace the JWT_SECRET missing message with a generic "Internal server error" to the client. Log the real reason server-side only \u2014 never expose configuration details in API responses.'],
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'Cache JWT_SECRET in a module-level variable set at startup, not read from process.env on every request. Validate its presence at boot time.'],
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'Add a runtime shape check after jwt.verify() to confirm the payload contains userId before casting to TokenPayload.'],
      ]),
      spacer(1),
      body('Safe JWT_SECRET missing response:', { bold: true }),
      codeLine('if (!jwtSecret) {'),
      codeLine('  console.error("[Auth] FATAL: JWT_SECRET env var is not set");'),
      codeLine('  return res.status(500).json({ message: "Internal server error" });'),
      codeLine('}'),
      spacer(1),

      // auth.controller.ts
      h2('2.5  auth.controller.ts  \u2014  Highest Priority File'),
      fileCard('halotasks-server/src/controllers/auth.controller.ts', 'P1', [
        ['\uD83D\uDD34 SECURITY', COLORS.white, COLORS.disaster, 'Replace Math.random() in generateResetCode() with crypto.randomInt(100000, 1000000). Math.random() is not cryptographically secure and is already imported at the top of the file.'],
        ['\uD83D\uDD34 SECURITY', COLORS.white, COLORS.disaster, 'Fix the reset code console.log in sendResetPasswordEmail. Currently the code is logged even when email delivery succeeds because the fallback executes after failed transport attempts. Guard it behind an explicit demoMode flag or restructure the control flow.'],
        ['\uD83D\uDD34 RELIABILITY', COLORS.white, COLORS.disaster, 'Validate RESET_TOKEN_TTL_MINUTES at startup. Number("abc") is NaN and will silently break all password resets. Use: const ttl = Number(process.env.RESET_TOKEN_TTL_MINUTES ?? "20"); if (isNaN(ttl)) throw new Error("Invalid RESET_TOKEN_TTL_MINUTES").'],
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'Replace the in-process Map rate limiter (forgotAttempts) with a Redis-backed or express-rate-limit solution. The current implementation resets on restart and does not work across multiple server instances.'],
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'Add password strength validation on registerUser, matching the minlength: 6 check that already exists on resetPassword.'],
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'Add input validation for name and email fields on registration (trim, maxlength, valid email format check).'],
      ]),
      spacer(1),
      body('Critical fix \u2014 generateResetCode():', { bold: true }),
      codeLine('// BEFORE (insecure):'),
      codeLine('const code = Math.floor(100000 + Math.random() * 900000);'),
      codeLine(''),
      codeLine('// AFTER (cryptographically secure):'),
      codeLine('const code = crypto.randomInt(100000, 1000000);'),
      spacer(1),

      // task.controller.ts
      h2('2.6  task.controller.ts'),
      fileCard('halotasks-server/src/controllers/task.controller.ts', 'P1', [
        ['\uD83D\uDD34 FIX', COLORS.white, COLORS.disaster, 'Validate req.params.id as a valid MongoDB ObjectId before passing to Mongoose. An invalid ID currently causes a CastError 500. Use: if (!mongoose.isValidObjectId(req.params.id)) return res.status(400).json({ message: "Invalid task ID" })'],
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'Add a dueDate validation check after parsing. new Date("garbage") produces Invalid Date which is stored silently.'],
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'Add pagination to getTasks (limit + skip query params, defaulting to limit=50). A user with 5,000 tasks will serialize the full collection on every dashboard load.'],
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'Return a 400 for empty string titles rather than silently ignoring them.'],
      ]),
      spacer(1),
      body('ObjectId validation pattern (add to updateTask and deleteTask):', { bold: true }),
      codeLine('const { id } = req.params;'),
      codeLine('if (!mongoose.isValidObjectId(id)) {'),
      codeLine('  return res.status(400).json({ message: "Invalid task ID" });'),
      codeLine('}'),
      spacer(1),
      new Paragraph({ children: [new PageBreak()] }),

      // SECTION 3: PHASE 2
      h1('3. Phase 2 \u2014 Important Improvements (Next Sprint)'),
      body('These changes significantly improve maintainability, type safety, and developer experience. None are blocking for a first deploy, but should be prioritized in the sprint immediately following the Phase 1 fixes.'),
      spacer(1),

      // config/db.ts
      h2('3.1  config/db.ts'),
      fileCard('halotasks-server/src/config/db.ts', 'P2', [
        ['\uD83D\uDD34 FIX', COLORS.white, COLORS.disaster, 'Document (with a comment) that dns.setServers() is a global, permanent mutation affecting all DNS lookups in the process \u2014 not just Mongoose. Consider resetting after the connection attempt or logging which path was taken.'],
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'Add serverSelectionTimeoutMS: 5000 to mongoose.connect() options. The default 30-second timeout makes crash loops very slow to detect.'],
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'Log which connection path was taken (direct vs. DNS fallback) and the hostname (not the full URI with credentials) for easier debugging.'],
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'If the DNS fallback also fails, dns.setServers() has already run. On auto-restart, the process starts with altered DNS. Consider wrapping the entire fallback block in a try/finally that resets DNS on failure.'],
      ]),
      spacer(1),

      // routes + express.d.ts
      h2('3.2  routes/  &  express.d.ts'),
      fileCard('routes/ & types/express.d.ts', 'P2', [
        ['\uD83D\uDD34 FIX', COLORS.white, COLORS.disaster, 'Create an AuthenticatedRequest interface that marks user as non-optional. Use it in all protected controllers instead of the base Request type. This prevents the pattern of req.user?.id returning undefined silently if middleware is ever bypassed.'],
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'Add /api/v1/ prefix to all routes. Once clients are deployed, breaking changes without versioning become painful.'],
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'Add a PATCH /:id route to task.routes.ts for partial updates (e.g. toggling completed). Sending the full task body for a single checkbox toggle is wasteful.'],
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'Introduce zod or express-validator at the route level. Move all input validation out of controllers and into reusable middleware schemas.'],
      ]),
      spacer(1),
      body('Recommended AuthenticatedRequest pattern:', { bold: true }),
      codeLine('// types/express.d.ts'),
      codeLine('export interface AuthenticatedRequest extends Request {'),
      codeLine('  user: { id: string; email: string; name: string };  // non-optional'),
      codeLine('}'),
      codeLine(''),
      codeLine('// In controllers:'),
      codeLine('export const getTasks = async (req: AuthenticatedRequest, res: Response) => {'),
      codeLine('  const tasks = await Task.find({ userId: req.user.id }); // no optional chain'),
      codeLine('};'),
      spacer(1),

      // tests
      h2('3.3  tests/api.routes.test.ts'),
      fileCard('tests/api.routes.test.ts', 'P2', [
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'Add tests for the forgotPassword and resetPassword flows: token stored hashed, expired token rejected, rate limiter enforced.'],
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'Add a test for invalid ObjectId: DELETE /api/tasks/not-an-id should return 400, not 500 (once the fix in 2.6 is applied).'],
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'Add tests for malformed Authorization headers: missing header, wrong scheme (Basic), empty Bearer value.'],
        ['\u26A0\uFE0F IMPROVE', COLORS.darkText, COLORS.warning, 'Add a comment clarifying TEST_JWT_SECRET is intentionally weak and must never be used outside of test context.'],
      ]),
      spacer(1),
      new Paragraph({ children: [new PageBreak()] }),

      // SECTION 4: RECOMMENDED ORDER
      h1('4. Recommended Fix Order'),
      body('Work through fixes in this exact sequence to maximize safety. Each step builds on the last.'),
      spacer(1),
      new Paragraph({ numbering: { reference: 'numbers', level: 0 }, spacing: { before: 60, after: 40 }, children: [new TextRun({ text: 'auth.controller.ts \u2014 Fix Math.random() and the reset code console.log first. These are the only active security vulnerabilities.', font: 'Arial', size: 22, color: COLORS.darkText })] }),
      new Paragraph({ numbering: { reference: 'numbers', level: 0 }, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: 'auth.middleware.ts \u2014 Fix the JWT_SECRET leak message. Second most important security issue.', font: 'Arial', size: 22, color: COLORS.darkText })] }),
      new Paragraph({ numbering: { reference: 'numbers', level: 0 }, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: 'task.controller.ts \u2014 Add ObjectId validation. Fixes the 500 CastError exposure.', font: 'Arial', size: 22, color: COLORS.darkText })] }),
      new Paragraph({ numbering: { reference: 'numbers', level: 0 }, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: 'app.ts \u2014 Fix the CORS wildcard fallback.', font: 'Arial', size: 22, color: COLORS.darkText })] }),
      new Paragraph({ numbering: { reference: 'numbers', level: 0 }, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: 'User.model.ts / Task.model.ts \u2014 Add schema validation constraints.', font: 'Arial', size: 22, color: COLORS.darkText })] }),
      new Paragraph({ numbering: { reference: 'numbers', level: 0 }, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: 'server.ts \u2014 Add crash handler and graceful shutdown.', font: 'Arial', size: 22, color: COLORS.darkText })] }),
      new Paragraph({ numbering: { reference: 'numbers', level: 0 }, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: 'express.d.ts + routes/ \u2014 Introduce AuthenticatedRequest and input validation middleware.', font: 'Arial', size: 22, color: COLORS.darkText })] }),
      new Paragraph({ numbering: { reference: 'numbers', level: 0 }, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: 'config/db.ts \u2014 Document and guard the DNS mutation side effect.', font: 'Arial', size: 22, color: COLORS.darkText })] }),
      new Paragraph({ numbering: { reference: 'numbers', level: 0 }, spacing: { before: 40, after: 40 }, children: [new TextRun({ text: 'tests/ \u2014 Expand coverage for forgotPassword, reset flow, and invalid inputs.', font: 'Arial', size: 22, color: COLORS.darkText })] }),
      spacer(1),

      // SECTION 5: EFFORT
      h1('5. Total Effort Estimate'),
      new Table({
        width: { size: 9360, type: WidthType.DXA },
        columnWidths: [3000, 2360, 4000],
        rows: [
          new TableRow({ children: [
            new TableCell({ width: { size: 3000, type: WidthType.DXA }, borders, shading: { fill: COLORS.primary, type: ShadingType.CLEAR }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Phase', font: 'Arial', size: 22, bold: true, color: COLORS.white })] })] }),
            new TableCell({ width: { size: 2360, type: WidthType.DXA }, borders, shading: { fill: COLORS.primary, type: ShadingType.CLEAR }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Effort', font: 'Arial', size: 22, bold: true, color: COLORS.white })] })] }),
            new TableCell({ width: { size: 4000, type: WidthType.DXA }, borders, shading: { fill: COLORS.primary, type: ShadingType.CLEAR }, margins: { top: 80, bottom: 80, left: 120, right: 120 }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: 'Notes', font: 'Arial', size: 22, bold: true, color: COLORS.white })] })] }),
          ]}),
          new TableRow({ children: [
            new TableCell({ width: { size: 3000, type: WidthType.DXA }, borders, shading: { fill: COLORS.lightRed, type: ShadingType.CLEAR }, margins: { top: 60, bottom: 60, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: 'Phase 1 \u2014 Critical (P1)', font: 'Arial', size: 22, bold: true, color: COLORS.disaster })] })] }),
            new TableCell({ width: { size: 2360, type: WidthType.DXA }, borders, shading: { fill: COLORS.white, type: ShadingType.CLEAR }, margins: { top: 60, bottom: 60, left: 120, right: 120 }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '12\u201318 hours', font: 'Arial', size: 22, color: COLORS.darkText })] })] }),
            new TableCell({ width: { size: 4000, type: WidthType.DXA }, borders, shading: { fill: COLORS.white, type: ShadingType.CLEAR }, margins: { top: 60, bottom: 60, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: 'All are small, targeted fixes. No refactoring required.', font: 'Arial', size: 22, color: COLORS.darkText })] })] }),
          ]}),
          new TableRow({ children: [
            new TableCell({ width: { size: 3000, type: WidthType.DXA }, borders, shading: { fill: COLORS.lightOrange, type: ShadingType.CLEAR }, margins: { top: 60, bottom: 60, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: 'Phase 2 \u2014 Improvements (P2)', font: 'Arial', size: 22, bold: true, color: COLORS.warning })] })] }),
            new TableCell({ width: { size: 2360, type: WidthType.DXA }, borders, shading: { fill: COLORS.white, type: ShadingType.CLEAR }, margins: { top: 60, bottom: 60, left: 120, right: 120 }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '8\u201312 hours', font: 'Arial', size: 22, color: COLORS.darkText })] })] }),
            new TableCell({ width: { size: 4000, type: WidthType.DXA }, borders, shading: { fill: COLORS.white, type: ShadingType.CLEAR }, margins: { top: 60, bottom: 60, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: 'Validation middleware and test expansion are the biggest tasks.', font: 'Arial', size: 22, color: COLORS.darkText })] })] }),
          ]}),
          new TableRow({ children: [
            new TableCell({ width: { size: 3000, type: WidthType.DXA }, borders, shading: { fill: COLORS.lightBlue, type: ShadingType.CLEAR }, margins: { top: 60, bottom: 60, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: 'Total', font: 'Arial', size: 22, bold: true, color: COLORS.primary })] })] }),
            new TableCell({ width: { size: 2360, type: WidthType.DXA }, borders, shading: { fill: COLORS.lightBlue, type: ShadingType.CLEAR }, margins: { top: 60, bottom: 60, left: 120, right: 120 }, children: [new Paragraph({ alignment: AlignmentType.CENTER, children: [new TextRun({ text: '20\u201330 hours', font: 'Arial', size: 22, bold: true, color: COLORS.primary })] })] }),
            new TableCell({ width: { size: 4000, type: WidthType.DXA }, borders, shading: { fill: COLORS.lightBlue, type: ShadingType.CLEAR }, margins: { top: 60, bottom: 60, left: 120, right: 120 }, children: [new Paragraph({ children: [new TextRun({ text: '2\u20133 focused engineering days to a fully production-ready server.', font: 'Arial', size: 22, color: COLORS.darkText })] })] }),
          ]}),
        ]
      }),
      spacer(1),

      // FOOTER NOTE
      spacer(1),
      new Paragraph({
        border: { top: { style: BorderStyle.SINGLE, size: 4, color: COLORS.medGray, space: 4 } },
        spacing: { before: 120, after: 0 },
        alignment: AlignmentType.CENTER,
        children: [new TextRun({ text: 'Halotask Pro Server Upgrade Plan \u2022 Generated by Claude Code Review \u2022 Continue with client-side review when ready', font: 'Arial', size: 18, color: COLORS.medGray, italics: true })]
      }),
    ]
  }]
});

Packer.toBuffer(doc).then(buffer => {
  fs.writeFileSync('D:\\Desktop\\College\\PROJECT\\HaloTaskPro\\docs\\Server_Upgrade_Plan.docx', buffer);
  console.log('Done');
});