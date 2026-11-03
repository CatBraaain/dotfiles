import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  FullConfig,
  FullResult,
  Reporter,
  Suite,
  TestCase,
  TestError,
  TestResult,
  TestStep,
} from "playwright/types/testReporter";
import { parseSpecCases, serializeGalleryRun } from "./e2eGallery";
import type {
  GalleryAttempt,
  GalleryImage,
  GalleryRun,
  GalleryStep,
  GalleryTest,
} from "./e2eGallery";

const IMAGE_EXTENSIONS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
};

type Attachment = TestResult["attachments"][number];

export default class E2eGalleryReporter implements Reporter {
  private outputDir = "";
  private tests: TestCase[] = [];
  private run: GalleryRun | undefined;
  private readonly attempts = new Map<TestResult, GalleryAttempt>();
  private readonly started = new Set<TestResult>();
  private readonly errors: string[] = [];
  private failure: unknown;

  printsToStdio(): boolean {
    return false;
  }

  onBegin(config: FullConfig, suite: Suite): void {
    try {
      const root = config.configFile ? dirname(config.configFile) : config.rootDir;
      this.outputDir = join(root, "dist/e2e-gallery");
      rmSync(this.outputDir, { recursive: true, force: true });
      mkdirSync(this.outputDir, { recursive: true });
      const source = readFileSync(join(root, "SPEC.md"), "utf8");
      this.tests = suite.allTests();
      this.run = {
        started: new Date().toISOString(),
        status: "running",
        environment: `${process.platform} / ${process.arch}`,
        errors: this.errors,
        tests: [],
        cases: parseSpecCases(source),
      };
      this.writeResults();
    } catch (error) {
      this.recordFailure(error);
    }
  }

  onTestBegin(_test: TestCase, result: TestResult): void {
    this.started.add(result);
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (this.failure || !this.run) return;
    try {
      this.attempts.set(result, this.saveAttempt(test, result));
      this.writeResults();
    } catch (error) {
      this.recordFailure(error);
    }
  }

  onError(error: TestError): void {
    this.errors.push(error.message ?? error.value ?? "Unknown Playwright error");
  }

  async onEnd(result: FullResult): Promise<{ status: "failed" } | undefined> {
    if (this.failure) return { status: "failed" };
    if (!this.run) return;
    try {
      this.run.status = result.status;
      for (const test of this.tests) {
        for (const attempt of test.results) {
          if (!this.attempts.has(attempt))
            this.attempts.set(attempt, this.saveAttempt(test, attempt));
        }
      }
      this.writeResults();
    } catch (error) {
      this.recordFailure(error);
      return { status: "failed" };
    }
  }

  private writeResults(): void {
    if (!this.run) return;
    this.run.tests = this.tests.map((test): GalleryTest => {
      const attempts = test.results.flatMap((result) => {
        const attempt = this.attempts.get(result);
        return attempt ? [attempt] : [];
      });
      const hasRun = attempts.some((attempt) => attempt.status !== "Not run");
      return {
        specId: test.annotations.find((annotation) => annotation.type === "spec")?.description,
        title: test.titlePath().filter(Boolean).join(" > "),
        project: test.parent.project()?.name ?? "",
        repeat: test.repeatEachIndex,
        outcome: hasRun ? outcomeLabel(test) : "Not run",
        attempts,
      };
    });
    const target = join(this.outputDir, "results.js");
    writeFileSync(`${target}.tmp`, serializeGalleryRun(this.run));
    renameSync(`${target}.tmp`, target);
  }

  private saveAttempt(test: TestCase, result: TestResult): GalleryAttempt {
    const testIndex = this.tests.indexOf(test);
    const directory = `assets/test-${testIndex + 1}/retry-${result.retry}-parallel-${result.parallelIndex}-worker-${result.workerIndex}`;
    const steps = saveSteps(result, (attachment, imageIndex) =>
      this.saveImage(attachment, directory, imageIndex),
    );
    const wasNotRun =
      result.workerIndex === -1 && test.expectedStatus !== "skipped" && !this.started.has(result);
    return {
      retry: result.retry,
      worker: result.workerIndex,
      parallel: result.parallelIndex,
      status: wasNotRun ? "Not run" : result.status,
      errors: result.errors.map((error) => error.message ?? error.value ?? "Unknown test error"),
      annotations: result.annotations
        .filter((annotation) => annotation.type !== "spec")
        .map((annotation) => `${annotation.type}: ${annotation.description ?? ""}`),
      steps,
    };
  }

  private saveImage(attachment: Attachment, directory: string, imageIndex: number): GalleryImage {
    const url = `${directory}/image-${imageIndex}.${IMAGE_EXTENSIONS[attachment.contentType]}`;
    const target = join(this.outputDir, url);
    try {
      mkdirSync(dirname(target), { recursive: true });
      if (attachment.body) writeFileSync(target, attachment.body);
      else if (attachment.path) copyFileSync(attachment.path, target);
      else throw new Error("Attachment has no file or body");
      const content = readFileSync(target);
      const isPng =
        content.length >= 24 &&
        content.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      return {
        name: attachment.name,
        url,
        width: isPng ? content.readUInt32BE(16) : undefined,
        height: isPng ? content.readUInt32BE(20) : undefined,
      };
    } catch (error) {
      return { name: attachment.name, error: String(error) };
    }
  }

  private recordFailure(error: unknown): void {
    this.failure = error;
    console.error(`E2E gallery generation failed: ${String(error)}`);
  }
}

function outcomeLabel(test: TestCase): string {
  const outcome = test.outcome();
  if (outcome === "expected")
    return test.expectedStatus === "failed" ? "Expected failure" : "Passed";
  const labels = { skipped: "Skipped", unexpected: "Failed", flaky: "Flaky" };
  return labels[outcome];
}

function saveSteps(
  result: TestResult,
  saveImage: (attachment: Attachment, index: number) => GalleryImage,
): GalleryStep[] {
  const steps: GalleryStep[] = [];
  const groups = new Map<TestStep, GalleryStep>();
  const seen = new Set<Attachment>();
  let imageIndex = 0;

  function visit(step: TestStep): void {
    if (step.category === "test.step") {
      const group = { title: userStepPath(step), status: stepStatus(step), images: [] };
      groups.set(step, group);
      steps.push(group);
    }
    for (const attachment of step.attachments) {
      if (!isImage(attachment) || seen.has(attachment)) continue;
      seen.add(attachment);
      let owner: TestStep | undefined = step;
      while (owner && owner.category !== "test.step") owner = owner.parent;
      const ownerStep = owner ?? step;
      let group = groups.get(ownerStep);
      if (!group) {
        group = { title: step.titlePath().join(" > "), status: stepStatus(step), images: [] };
        groups.set(ownerStep, group);
        steps.push(group);
      }
      group.images.push(saveImage(attachment, ++imageIndex));
    }
    step.steps.forEach(visit);
  }
  result.steps.forEach(visit);

  const unscopedImages = result.attachments.filter(
    (attachment) => isImage(attachment) && !seen.has(attachment),
  );
  if (unscopedImages.length) {
    steps.push({
      title: "Outside test.step",
      status: "Attachment only",
      images: unscopedImages.map((attachment) => saveImage(attachment, ++imageIndex)),
    });
  }
  return steps;
}

function stepStatus(step: TestStep): string {
  if (step.error) return "Failed";
  return step.duration < 0 ? "Interrupted" : "Completed";
}

function isImage(attachment: Attachment): boolean {
  return Object.hasOwn(IMAGE_EXTENSIONS, attachment.contentType);
}

function userStepPath(step: TestStep): string {
  const titles: string[] = [];
  let ancestor: TestStep | undefined = step;
  while (ancestor) {
    if (ancestor.category === "test.step") titles.unshift(ancestor.title);
    ancestor = ancestor.parent;
  }
  return titles.join(" > ");
}
