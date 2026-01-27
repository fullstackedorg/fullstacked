import { after, before, beforeEach, suite, test } from "node:test";
import child_process from "node:child_process";
import fs from "node:fs";
import git from "../../core/internal/bundle/lib/git/index.ts";
import assert from "node:assert";

const localGitServerDirectory = "test/git/local-git-server";
const testDirectory = "test/git/test";

function resetRepositories() {
    if (fs.existsSync(testDirectory))
        fs.rmSync(testDirectory, { recursive: true });
    fs.mkdirSync(testDirectory, { recursive: true });
    child_process.execSync(
        "docker compose exec git-server /bin/bash /home/setup.sh",
        {
            cwd: localGitServerDirectory,
            stdio: "ignore"
        }
    );
}

function cloneRepository(name: "test" | "empty", directory = testDirectory) {
    return git.clone(`http://localhost:8080/${name}`, directory).promise();
}

suite("git - e2e", () => {
    before(() => {
        child_process.execSync("docker compose up --build -d", {
            cwd: localGitServerDirectory,
            stdio: "ignore"
        });
    });

    beforeEach(resetRepositories);

    test("clone - empty", async () => {
        await cloneRepository("empty");
        assert.deepEqual([".git"], fs.readdirSync(`${testDirectory}`));
    });

    test("clone", async () => {
        await cloneRepository("test");
        assert.deepEqual(
            [".git", "test.txt"],
            fs.readdirSync(`${testDirectory}`)
        );
        assert.deepEqual(
            "test file\n",
            fs.readFileSync(`${testDirectory}/test.txt`, { encoding: "utf-8" })
        );
    });

    test("log", async () => {
        await cloneRepository("test");
        const logs = git.log(testDirectory);

        const logsGit = child_process
            .execSync("git log -n 10", { cwd: testDirectory })
            .toString();
        const hash = logsGit
            .match(/commit .*/g)?.[0]
            ?.split(" ")
            ?.pop()
            ?.trim();
        const author = {
            name: logsGit
                .match(/Author: .*</g)?.[0]
                ?.split(" ")
                ?.slice(1, -1)
                ?.join(" ")
                ?.trim(),
            email: logsGit.match(/<.*>/g)?.[0]?.slice(1, -1)
        };
        const date = logsGit
            .match(/Date:.*/g)?.[0]
            ?.split("   ")
            ?.pop()
            ?.trim();
        const message = logsGit.match(/    .*/g)?.[0]?.trim();

        assert.deepEqual(
            [
                {
                    hash,
                    author,
                    date,
                    message
                }
            ],
            logs
        );
    });

    test("status / add", async () => {
        await cloneRepository("test");
        fs.writeFileSync(`${testDirectory}/test.txt`, "testing");
        fs.writeFileSync(`${testDirectory}/foo.txt`, "bar");
        fs.writeFileSync(`${testDirectory}/baz.txt`, "alpha");

        git.add("foo.txt", testDirectory);

        const status = git.status(testDirectory);

        const gitStatus = child_process
            .execSync("git status", { cwd: testDirectory })
            .toString();

        const branch = gitStatus
            .match(/On branch.*/g)?.[0]
            ?.split(" ")
            ?.pop()
            ?.trim();
        assert.deepEqual(branch, status.head.branch);

        const staged = gitStatus
            .match(/Changes to be committed:(\s|.)*?\n\n/g)?.[0]
            ?.match(/new file:.*/g)?.[0]
            ?.split(" ")
            ?.pop()
            ?.trim();
        assert.ok(staged);
        assert.deepEqual(staged, status.staged.added.at(0));

        const unstaged = gitStatus
            .match(/Changes not staged for commit:(\s|.)*?\n\n/g)?.[0]
            ?.match(/modified:.*/g)?.[0]
            ?.split(" ")
            ?.pop()
            ?.trim();
        assert.ok(unstaged);
        assert.deepEqual(unstaged, status.unstaged.modified.at(0));

        const untracked = gitStatus.trim().split("\n")?.at(-1).trim();
        assert.ok(untracked);
        assert.deepEqual(untracked, status.untracked.at(0));
    });

    test("commit", async () => {
        await cloneRepository("empty");
        fs.writeFileSync(`${testDirectory}/test.txt`, "123");
        git.add(".", testDirectory);
        const name = "user test";
        const email = "test@testing.com";
        const message = "test commit";
        const hash = git.commit(message, name, email, testDirectory);
        const [log] = git.log(testDirectory);
        assert.deepEqual(log.hash, hash);
        assert.deepEqual(log.author.name, name);
        assert.deepEqual(log.author.email, email);
        assert.deepEqual(log.message, message);
    });

    test("pull", async () => {
        const testingDirectory = `${testDirectory}/test`;
        const actualDirectory = `${testDirectory}/actual`;
        await cloneRepository("test", testingDirectory);
        await cloneRepository("test", actualDirectory);
        assert.deepEqual(git.log(testingDirectory).length, 1);
        fs.writeFileSync(`${actualDirectory}/test.txt`, "123");
        child_process.execSync(
            `git commit -a --author="test user <test@testing.com>" -m "test commit 2"`,
            {
                cwd: actualDirectory,
                stdio: "ignore"
            }
        );
        child_process.execSync(`git push`, {
            cwd: actualDirectory,
            stdio: "ignore"
        });
        await git.pull(testingDirectory).promise();
        assert.deepEqual(git.log(testingDirectory).length, 2);
    });

    test("push", async () => {
        await cloneRepository("test");
        assert.deepEqual(git.log(testDirectory).length, 1);
        fs.writeFileSync(`${testDirectory}/test.txt`, "testing 2");
        git.add(".", testDirectory);
        git.commit(
            "test commit 2",
            "test user",
            "test@testing.com",
            testDirectory
        );
        await git.push(testDirectory).promise();
        fs.rmSync(testDirectory, { recursive: true });
        await cloneRepository("test");
        assert.deepEqual(git.log(testDirectory).length, 2);
    });

    test("reset", async () => {
        await cloneRepository("test");
        const status1 = git.status(testDirectory);
        fs.writeFileSync(`${testDirectory}/test.txt`, "test 2");
        const status2 = git.status(testDirectory);
        assert.notDeepEqual(status1, status2);
        git.add(".", testDirectory);
        const status3 = git.status(testDirectory);
        assert.notDeepEqual(status2, status3);
        git.reset(testDirectory);
        assert.deepEqual(git.status(testDirectory), status2);
    });

    after(() => {
        resetRepositories();
        child_process.execSync("docker compose down", {
            cwd: localGitServerDirectory,
            stdio: "ignore"
        });
    });
});
