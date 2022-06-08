import { GitPOAP, Organization, Repo } from '@generated/type-graphql';
import { context } from '../context';
import { createScopedLogger } from '../logging';
import { getGithubRepositoryPullsAsAdmin } from '../external/github';
import { DateTime } from 'luxon';
import { sleep } from './sleep';
import {
  ongoingIssuanceProjectDurationSeconds,
  overallOngoingIssuanceDurationSeconds,
} from '../metrics';
import { extractMergeCommitSha } from './pullRequests';
import { upsertUser } from './users';

// The number of pull requests to request in a single page (currently the maximum number)
const PULL_STEP_SIZE = 100;

// The name of the row in the BatchTiming table used for ongoing issuance
const ONGOING_ISSUANCE_BATCH_TIMING_KEY = 'ongoing-issuance';

// The amount of hours to wait before checking for new contributions
const ONGOING_ISSUANCE_DELAY_HOURS = 12;

// The amount of minutes to wait in between the checks for separate projects.
// Currently we don't expect to be rate limited by GitHub for this background
// process, but this is good to have in place as we add more projects that
// require ongoing checks
const DELAY_BETWEEN_ONGOING_ISSUANCE_CHECKS_SECONDS = 60;

type GitPOAPReturnType = {
  id: number;
  year: number;
  lastPRUpdatedAt: Date;
  repo: {
    id: number;
    name: string;
    organization: { name: string };
  };
};

export async function checkForNewContributions(gitPOAP: GitPOAPReturnType) {
  const logger = createScopedLogger('checkForNewContributions');

  const project = `${gitPOAP.repo.organization.name}/${gitPOAP.repo.name}`;
  logger.info(`Checking for new contributions to ${project}`);

  const endTimer = ongoingIssuanceProjectDurationSeconds.startTimer(project);

  let page = 1;
  let isProcessing = true;
  let lastUpdatedAt = null;
  while (isProcessing) {
    const pulls = await getGithubRepositoryPullsAsAdmin(
      gitPOAP.repo.organization.name,
      gitPOAP.repo.name,
      PULL_STEP_SIZE,
      page,
      'desc',
    );
    if (pulls === null) {
      logger.error(`Failed to run ongoing issuance process for GitPOAP id: ${gitPOAP.id}`);
      endTimer({ success: 0 });
      return;
    }

    logger.debug(`Retrieved ${pulls.length} pulls for processing`);

    for (const pull of pulls) {
      // If the PR hasn't been merged yet, skip it
      if (pull.merged_at === null) {
        continue;
      }

      const updatedAt = new Date(pull.updated_at);

      // Save the first updatedAt value
      if (lastUpdatedAt === null) {
        lastUpdatedAt = updatedAt;
      }

      // Stop if we've already handled this PR
      if (updatedAt < gitPOAP.lastPRUpdatedAt) {
        isProcessing = false;
        break;
      }

      logger.info(`Creating a claim for ${pull.user.login} if it doesn't exist`);

      // Create the User, GithubPullRequest, and Claim if they don't exist
      const user = await upsertUser(pull.user.id, pull.user.login);

      const githubPullRequest = await context.prisma.githubPullRequest.upsert({
        where: {
          repoId_githubPullNumber: {
            repoId: gitPOAP.repo.id,
            githubPullNumber: pull.number,
          },
        },
        // Assume only the title can change for now
        update: {
          githubTitle: pull.title,
        },
        create: {
          githubPullNumber: pull.number,
          githubTitle: pull.title,
          githubMergedAt: new Date(pull.merged_at),
          githubMergeCommitSha: extractMergeCommitSha(pull),
          repo: {
            connect: {
              id: gitPOAP.repo.id,
            },
          },
          user: {
            connect: {
              id: user.id,
            },
          },
        },
      });

      const mergedAt = DateTime.fromISO(pull.merged_at);

      // Log an error if we haven't figured out what to do in the new years
      if (mergedAt.year > gitPOAP.year) {
        logger.error(`Found a merged PR for GitPOAP ID ${gitPOAP.id} for a new year`);
        endTimer({ success: 0 });
        return;
        // Don't handle previous years (note we still handle an updated title)
      } else if (mergedAt.year < gitPOAP.year) {
        continue;
      }

      await context.prisma.claim.upsert({
        where: {
          gitPOAPId_userId: {
            gitPOAPId: gitPOAP.id,
            userId: user.id,
          },
        },
        update: {},
        create: {
          gitPOAP: {
            connect: {
              id: gitPOAP.id,
            },
          },
          user: {
            connect: {
              id: user.id,
            },
          },
          pullRequestEarned: {
            connect: {
              id: githubPullRequest.id,
            },
          },
        },
      });
    }

    ++page;
    isProcessing = pulls.length === PULL_STEP_SIZE;
  }

  if (lastUpdatedAt !== null) {
    await context.prisma.gitPOAP.update({
      where: {
        id: gitPOAP.id,
      },
      data: {
        lastPRUpdatedAt: lastUpdatedAt,
      },
    });
  }

  endTimer({ success: 1 });

  logger.debug(
    `Finished checking for new contributions to ${gitPOAP.repo.organization.name}/${gitPOAP.repo.name}`,
  );
}

async function runOngoingIssuanceUpdater() {
  const logger = createScopedLogger('runOngoingIssuanceUpdater');

  logger.info('Running the ongoing issuance updater process');

  const endTimer = overallOngoingIssuanceDurationSeconds.startTimer();

  const gitPOAPs: GitPOAPReturnType[] = await context.prisma.gitPOAP.findMany({
    where: {
      ongoing: true,
    },
    select: {
      id: true,
      year: true,
      lastPRUpdatedAt: true,
      repo: {
        select: {
          id: true,
          name: true,
          organization: {
            select: {
              name: true,
            },
          },
        },
      },
    },
  });

  logger.info(`Found ${gitPOAPs.length} ongoing GitPOAPs that need to be checked`);

  for (let i = 0; i < gitPOAPs.length; ++i) {
    if (i > 0) {
      logger.debug(
        `Waiting ${DELAY_BETWEEN_ONGOING_ISSUANCE_CHECKS_SECONDS} seconds before checking the next GitPOAP`,
      );

      // Wait for a bit so we don't get rate limited
      await sleep(DELAY_BETWEEN_ONGOING_ISSUANCE_CHECKS_SECONDS);
    }

    await checkForNewContributions(gitPOAPs[i]);
  }

  endTimer({ processed_count: gitPOAPs.length });

  logger.debug('Finished running the ongoing issuance updater process');
}

// Try to run ongoing issuance updater if there has been enough time elapsed since
// any instance last ran it
export async function tryToRunOngoingIssuanceUpdater() {
  const logger = createScopedLogger('tryToRunOngoingIssuanceUpdater');

  logger.info('Attempting to run the ongoing issuance updater');

  try {
    const batchTiming = await context.prisma.batchTiming.findUnique({
      where: {
        name: ONGOING_ISSUANCE_BATCH_TIMING_KEY,
      },
    });

    if (batchTiming !== null) {
      const lastRun = DateTime.fromJSDate(batchTiming.lastRun);

      // If not enough time has elapsed since the last run, skip the run
      if (lastRun.plus({ hours: ONGOING_ISSUANCE_DELAY_HOURS }) > DateTime.now()) {
        logger.debug('Not enough time has elapsed since the last run');
        return;
      }
    }

    // Update the last time ran to now (we do this first so the other instance
    // also doesn't start this process)
    const now = DateTime.now().toJSDate();
    await context.prisma.batchTiming.upsert({
      where: {
        name: ONGOING_ISSUANCE_BATCH_TIMING_KEY,
      },
      update: {
        lastRun: now,
      },
      create: {
        name: ONGOING_ISSUANCE_BATCH_TIMING_KEY,
        lastRun: now,
      },
    });

    await runOngoingIssuanceUpdater();

    logger.debug('Finished running the ongoing issuance updater');
  } catch (err) {
    logger.error(`Failed to run ongoing issuance updater: ${err}`);
  }
}
