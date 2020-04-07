import nock from "nock";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { Probot } from "probot";
// Requiring our app implementation
import myProbotApp from "../src";

const readFile = promisify(fs.readFile);

describe("steward-bot", () => {
  let probot: Probot;
  let mockCert: string;

  beforeAll(async () => {
    mockCert = await readFile(path.join(__dirname, "fixtures/mock-cert.pem"), "utf8");
  });

  beforeEach(() => {
    nock.disableNetConnect();
    probot = new Probot({ id: 123, cert: mockCert });
    // Load our app into probot
    console.log("ignore the following deprecation about auth, see https://github.com/probot/probot/issues/1139");
    probot.load(myProbotApp);
  });

  afterEach(() => {
    nock.cleanAll();
    nock.enableNetConnect();
  });
});
