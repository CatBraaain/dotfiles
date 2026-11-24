import { describe, it } from "bun:test";
import assert from "node:assert/strict";
import type { DateTime } from "./datetime.ts";
import { parseDefs } from "./def.ts";
import { normalizedTaskXml, renderTaskXml } from "./xml.ts";

// tests/common/mod.rs: strips the shared two-space indent from each line.
const definitions = (tasks: string): string =>
  tasks
    .split("\n")
    .map((line) => (line.startsWith("  ") ? line.slice(2) : line))
    .join("\n");

const compact = (xml: string) => xml.replace(/\s+/g, "");
const now = (): DateTime => ({ y: 2026, mo: 9, d: 20, h: 8, mi: 0, s: 0 });
const at = (hour: number, minute: number): DateTime => ({
  y: 2026,
  mo: 1,
  d: 15,
  h: hour,
  mi: minute,
  s: 0,
});

function render(expression: string): string {
  const yaml = definitions(
    `  - name: task\n    trigger: { type: cron, value: '${expression}' }\n    action: { command: cmd.exe }\n`,
  );
  const defs = parseDefs(yaml, "wintasks.yaml", "WinTasks");
  return renderTaskXml(defs.tasks[0]!, at(10, 0));
}

describe("render xml", () => {
  it("renders spec xml shape without management metadata", () => {
    const yaml = definitions(
      "  - name: backup\n    trigger: { type: cron, value: '0 9 * * MON' }\n    action: { command: 'C:\\Tools\\backup.exe', args: --full, working_directory: 'C:\\Backup' }\n",
    );
    const defs = parseDefs(yaml, "wintasks.yaml", "WinTasks");
    const xml = renderTaskXml(defs.tasks[0]!, now());
    assert.ok(
      xml.startsWith(
        '<?xml version="1.0" encoding="UTF-8"?>\n<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">',
      ),
    );
    assert.ok(xml.includes("  <RegistrationInfo/>\n  <Triggers>"));
    assert.ok(
      !xml.includes("Description") && !xml.includes("def-hash") && !xml.includes("managed-by"),
    );
    assert.ok(xml.includes("<Monday/>"));
    assert.ok(xml.includes("<RunLevel>LeastPrivilege</RunLevel>"));
    assert.ok(xml.includes("<LogonType>InteractiveToken</LogonType>"));
    assert.ok(xml.includes("<StartWhenAvailable>true</StartWhenAvailable>"));
    assert.ok(xml.includes("<WorkingDirectory>C:\\Backup</WorkingDirectory>"));
  });

  it("renders the spec example as the exact full document", () => {
    const yaml = definitions(
      '  - name: backup\n    trigger:\n      type: cron\n      value: "0 9 * * MON"\n    action:\n      command: C:\\Tools\\backup.exe\n      args: --full\n      working_directory: C:\\Backup\n',
    );
    const defs = parseDefs(yaml, "wintasks.yaml", "WinTasks");
    const xml = renderTaskXml(defs.tasks[0]!, now());
    const expected = `<?xml version="1.0" encoding="UTF-8"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo/>
  <Triggers>
    <CalendarTrigger>
      <StartBoundary>2026-09-20T09:00:00</StartBoundary>
      <ScheduleByWeek>
        <DaysOfWeek>
          <Monday/>
        </DaysOfWeek>
      </ScheduleByWeek>
    </CalendarTrigger>
  </Triggers>
  <Principals>
    <Principal>
      <RunLevel>LeastPrivilege</RunLevel>
      <LogonType>InteractiveToken</LogonType>
    </Principal>
  </Principals>
  <Settings>
    <StartWhenAvailable>true</StartWhenAvailable>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
  </Settings>
  <Actions>
    <Exec>
      <Command>C:\\Tools\\backup.exe</Command>
      <Arguments>--full</Arguments>
      <WorkingDirectory>C:\\Backup</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`;
    assert.equal(compact(xml), compact(expected), `generated:\n${xml}`);
  });

  it("renders all trigger types and actions", () => {
    const yaml = definitions(
      "  - name: many\n    trigger:\n      - { type: startup, value: '01:30' }\n      - { type: boot, value: '00:30' }\n      - { type: once, value: '2030-06-01' }\n      - { type: now, value: unused }\n    action:\n      - { command: cmd.exe }\n      - { command: 'C:\\Tools\\a.exe', args: --one }\n",
    );
    const defs = parseDefs(yaml, "wintasks.yaml", "WinTasks");
    const output = renderTaskXml(defs.tasks[0]!, now());
    assert.ok(output.includes("<Delay>PT1H30M</Delay>"));
    assert.ok(output.includes("<Delay>PT30M</Delay>"));
    assert.ok(output.includes("<StartBoundary>2030-06-01T00:00:00</StartBoundary>"));
    assert.ok(output.includes("<RegistrationTrigger/>"));
    assert.equal(output.split("<Exec>").length - 1, 2);
    assert.ok(!output.includes("<Arguments></Arguments>"));
    const triggerPositions = [
      output.indexOf("<Delay>PT1H30M</Delay>"),
      output.indexOf("<Delay>PT30M</Delay>"),
      output.indexOf("<StartBoundary>2030-06-01T00:00:00</StartBoundary>"),
      output.indexOf("<RegistrationTrigger/>"),
    ];
    assert.ok(
      triggerPositions.every(
        (position, index) => index === 0 || triggerPositions[index - 1]! < position,
      ),
      `triggers must keep YAML order: ${output}`,
    );
    const commandPositions = [
      output.indexOf("<Command>cmd.exe</Command>"),
      output.indexOf("<Command>C:\\Tools\\a.exe</Command>"),
    ];
    assert.ok(
      commandPositions[0]! < commandPositions[1]!,
      `actions must keep YAML order: ${output}`,
    );
  });

  it("normalizing ignores only description and calendar boundaries", () => {
    const current =
      '<Task z="z" a="a"><RegistrationInfo><Description>old</Description></RegistrationInfo><Triggers><CalendarTrigger><StartBoundary>old</StartBoundary></CalendarTrigger></Triggers></Task>';
    const same =
      '<Task a="a" z="z"><RegistrationInfo><Description>new</Description></RegistrationInfo><Triggers><CalendarTrigger><StartBoundary>new</StartBoundary></CalendarTrigger></Triggers></Task>';
    assert.equal(normalizedTaskXml(current), normalizedTaskXml(same));
  });

  it("normalizing ignores scheduler metadata and defaults", () => {
    const current =
      '<Task><RegistrationInfo><URI>old-uri</URI><Date>old</Date></RegistrationInfo><Principals><Principal><UserId>old</UserId><RunLevel>LeastPrivilege</RunLevel><LogonType>InteractiveToken</LogonType></Principal></Principals><Settings><Enabled>true</Enabled><StartWhenAvailable>true</StartWhenAvailable></Settings><Actions Context="Author"><Exec><Command>cmd.exe</Command></Exec></Actions></Task>';
    const desired =
      "<Task><RegistrationInfo/><Principals><Principal><RunLevel>LeastPrivilege</RunLevel><LogonType>InteractiveToken</LogonType></Principal></Principals><Settings><StartWhenAvailable>true</StartWhenAvailable></Settings><Actions><Exec><Command>cmd.exe</Command></Exec></Actions></Task>";
    assert.equal(normalizedTaskXml(current), normalizedTaskXml(desired));
  });

  it("normalizing scheduler reordering and zero delays is stable", () => {
    const current =
      '<Task><Principals><Principal id="Author"><RunLevel>LeastPrivilege</RunLevel><LogonType>InteractiveToken</LogonType></Principal></Principals><Settings><StartWhenAvailable>true</StartWhenAvailable></Settings><Triggers><BootTrigger/></Triggers><RegistrationInfo/></Task>';
    const desired =
      "<Task><RegistrationInfo/><Triggers><BootTrigger><Delay>PT0S</Delay></BootTrigger></Triggers><Principals><Principal><RunLevel>LeastPrivilege</RunLevel><LogonType>InteractiveToken</LogonType></Principal></Principals><Settings><StartWhenAvailable>true</StartWhenAvailable></Settings></Task>";
    assert.equal(normalizedTaskXml(current), normalizedTaskXml(desired));
  });

  it("normalizing reorders owned principal and settings children", () => {
    const current =
      "<Task><Principals><Principal><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries><StartWhenAvailable>true</StartWhenAvailable><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries></Settings></Task>";
    const desired =
      "<Task><Principals><Principal><RunLevel>LeastPrivilege</RunLevel><LogonType>InteractiveToken</LogonType></Principal></Principals><Settings><StartWhenAvailable>true</StartWhenAvailable><DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries><StopIfGoingOnBatteries>false</StopIfGoingOnBatteries></Settings></Task>";
    assert.equal(normalizedTaskXml(current), normalizedTaskXml(desired));
  });

  it("normalizing preserves entity references and ignores cdata whitespace", () => {
    const current =
      "<Task><Actions><Exec><Arguments>a&amp;b</Arguments><Command><![CDATA[   ]]></Command></Exec></Actions></Task>";
    const desired =
      "<Task><Actions><Exec><Arguments>ab</Arguments><Command>   </Command></Exec></Actions></Task>";
    assert.notEqual(normalizedTaskXml(current), normalizedTaskXml(desired));

    const equivalent =
      "<Task><Actions><Exec><Arguments>a&amp;b</Arguments><Command>   </Command></Exec></Actions></Task>";
    assert.equal(normalizedTaskXml(current), normalizedTaskXml(equivalent));
  });

  it("writes escaped character data and attributes in normalized XML", () => {
    const xml =
      '<Task label="a&amp;&quot;b"><Actions><Exec><Arguments>a&amp;&lt;b</Arguments></Exec></Actions></Task>';
    const normalized = normalizedTaskXml(xml);
    assert.ok(normalized.includes('label="a&amp;&quot;b"'), normalized);
    assert.ok(normalized.includes("<Arguments>a&amp;&lt;b</Arguments>"), normalized);
    assert.equal(normalizedTaskXml(normalized), normalized);
  });

  it("distinguishes numeric character references from literal reference text", () => {
    const references = '<Task label="&#65;&#x41;"><Data>&#65;&#x41;</Data></Task>';
    const resolved = '<Task label="AA"><Data>AA</Data></Task>';
    const literal = '<Task label="&amp;#65;&amp;#x41;"><Data>&amp;#65;&amp;#x41;</Data></Task>';
    assert.equal(normalizedTaskXml(references), normalizedTaskXml(resolved));
    assert.notEqual(normalizedTaskXml(references), normalizedTaskXml(literal));
  });

  it("keeps numeric-looking action values as text", () => {
    const xml = "<Task><Actions><Exec><Arguments>00123</Arguments></Exec></Actions></Task>";
    const normalized = normalizedTaskXml(xml);
    assert.ok(normalized.includes("<Arguments>00123</Arguments>"), normalized);
  });

  it("root child order and settings are exact", () => {
    const yaml = definitions(
      "  - name: admin\n    trigger: { type: now, value: x }\n    action: { command: cmd.exe }\n    setting: { run_as: true, logon_type: s4u }\n",
    );
    const defs = parseDefs(yaml, "wintasks.yaml", "WinTasks");
    const xml = renderTaskXml(defs.tasks[0]!, now());
    const positions = [
      xml.indexOf("<RegistrationInfo/>"),
      xml.indexOf("<Triggers>"),
      xml.indexOf("<Principals>"),
      xml.indexOf("<Settings>"),
      xml.indexOf("<Actions>"),
    ];
    assert.ok(
      positions.every((position, index) => index === 0 || positions[index - 1]! < position),
    );
    assert.ok(xml.includes("<RunLevel>HighestAvailable</RunLevel>"));
    assert.ok(xml.includes("<LogonType>S4U</LogonType>"));
    assert.ok(xml.includes("<StartWhenAvailable>true</StartWhenAvailable>"));
    assert.ok(xml.includes("<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>"));
    assert.ok(xml.includes("<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>"));
  });

  it("documented conversion cases match expected fragments", () => {
    const triggerCases: Array<[string, string, DateTime, string]> = [
      ["startup", "01:30", now(), "<LogonTrigger><Delay>PT1H30M</Delay></LogonTrigger>"],
      ["boot", "00:30", now(), "<BootTrigger><Delay>PT30M</Delay></BootTrigger>"],
      [
        "once",
        "2030-06-01",
        now(),
        "<TimeTrigger><StartBoundary>2030-06-01T00:00:00</StartBoundary></TimeTrigger>",
      ],
      ["now", "x", now(), "<RegistrationTrigger/>"],
      [
        "cron",
        "0 11 * * *",
        at(10, 0),
        "<CalendarTrigger><StartBoundary>2026-01-15T11:00:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>",
      ],
      [
        "cron",
        "0 9 * * *",
        at(10, 0),
        "<CalendarTrigger><StartBoundary>2026-01-16T09:00:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>",
      ],
      [
        "cron",
        "*/15 9-17 * * *",
        at(10, 0),
        "<CalendarTrigger><StartBoundary>2026-01-16T09:00:00</StartBoundary><Repetition><Interval>PT15M</Interval><Duration>PT9H</Duration></Repetition><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>",
      ],
      [
        "cron",
        "0,30 9,21 * * *",
        at(10, 0),
        "<CalendarTrigger><StartBoundary>2026-01-16T09:00:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger><CalendarTrigger><StartBoundary>2026-01-16T09:30:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger><CalendarTrigger><StartBoundary>2026-01-15T21:00:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger><CalendarTrigger><StartBoundary>2026-01-15T21:30:00</StartBoundary><ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>",
      ],
    ];
    for (const [kind, value, time, expected] of triggerCases) {
      const yaml = definitions(
        `  - name: sample\n    trigger: { type: ${kind}, value: '${value}' }\n    action: { command: cmd.exe }\n`,
      );
      const defs = parseDefs(yaml, "wintasks.yaml", "WinTasks");
      const xml = renderTaskXml(defs.tasks[0]!, time);
      const triggers = xml.slice(
        xml.indexOf("<Triggers>") + "<Triggers>".length,
        xml.indexOf("</Triggers>"),
      );
      assert.equal(compact(triggers), compact(expected), `${kind} ${value}: ${xml}`);
    }

    const actionCases: Array<[string, string | null, string | null, string]> = [
      ["cmd.exe", null, null, "<Exec><Command>cmd.exe</Command></Exec>"],
      [
        "C:\\Tools\\a.exe",
        "--one",
        null,
        "<Exec><Command>C:\\Tools\\a.exe</Command><Arguments>--one</Arguments><WorkingDirectory>C:\\Tools</WorkingDirectory></Exec>",
      ],
      [
        "C:\\Tools\\a.exe",
        null,
        "C:\\Data",
        "<Exec><Command>C:\\Tools\\a.exe</Command><WorkingDirectory>C:\\Data</WorkingDirectory></Exec>",
      ],
    ];
    for (const [command, args, directory, expected] of actionCases) {
      const argsText = args === null ? "" : `, args: ${args}`;
      const directoryText = directory === null ? "" : `, working_directory: '${directory}'`;
      const yaml = definitions(
        `  - name: sample\n    trigger: { type: now, value: x }\n    action: { command: '${command}'${argsText}${directoryText} }\n`,
      );
      const defs = parseDefs(yaml, "wintasks.yaml", "WinTasks");
      const xml = renderTaskXml(defs.tasks[0]!, now());
      const actions = xml.slice(
        xml.indexOf("<Actions>") + "<Actions>".length,
        xml.indexOf("</Actions>"),
      );
      assert.equal(compact(actions), compact(expected), `${xml}`);
    }
  });
});

describe("cron integration", () => {
  it("parses documented field forms and rejects invalid extensions", () => {
    for (const expression of [
      "*/15 9-17 * * MON-FRI",
      "0 12 1-3,5 JAN,DEC *",
      "3/6 3/6 * * *",
      "0 12 ? * ?",
    ]) {
      assert.doesNotThrow(() => render(expression), expression);
    }
    for (const expression of [
      "@daily",
      "1,3/2 * * * *",
      "* * * */5 *",
      "* * * * 7",
      "*/60 * * * *",
      "* */24 * * *",
      "* * */32 * *",
    ]) {
      assert.throws(() => render(expression), Error, expression);
    }
  });

  it("decomposes cron schedules and corrects past boundaries", () => {
    let output = render("*/15 9-17 * * *");
    assert.ok(output.includes("<StartBoundary>2026-01-16T09:00:00</StartBoundary>"));
    assert.ok(output.includes("<Interval>PT15M</Interval>"));
    assert.ok(output.includes("<Duration>PT9H</Duration>"));

    output = render("0,30 9,21 * * *");
    assert.equal(output.split("<CalendarTrigger>").length - 1, 4);

    output = render("0 12 1 * MON");
    assert.equal(output.split("<CalendarTrigger>").length - 1, 2);
    assert.ok(output.includes("<ScheduleByMonth>"));
    assert.ok(output.includes("<ScheduleByMonthDayOfWeek>"));
  });

  it("sunday started weekday ranges are valid", () => {
    for (const expression of ["0 12 * * 0-2", "0 12 * * SUN-TUE"]) {
      const output = render(expression);
      assert.ok(output.includes("<Sunday/>"), `${expression}: ${output}`);
      assert.ok(output.includes("<Tuesday/>"), `${expression}: ${output}`);
    }
  });

  it("accepts steps at the field maximum", () => {
    for (const expression of ["*/59 * * * *", "* */23 * * *", "* * */31 * *"]) {
      assert.doesNotThrow(() => render(expression), expression);
    }
  });

  it("n slash one steps from n to the field maximum", () => {
    const output = render("3/1 9 * * *");
    assert.equal(output.split("<CalendarTrigger>").length - 1, 1);
    assert.ok(output.includes("<StartBoundary>2026-01-16T09:03:00</StartBoundary>"));
    assert.ok(output.includes("<Interval>PT1M</Interval>"));
    assert.ok(output.includes("<Duration>PT57M</Duration>"));
  });
});
