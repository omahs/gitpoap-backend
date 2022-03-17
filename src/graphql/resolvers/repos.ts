import { Arg, Ctx, Resolver, Query } from 'type-graphql';
import { Repo } from '@generated/type-graphql';
import { getLastMonthStartDatetime } from './util';
import { Context } from '../../context';
import { createScopedLogger } from '../../logging';

@Resolver(of => Repo)
export class CustomRepoResolver {
  @Query(returns => Number)
  async totalRepos(@Ctx() { prisma }: Context): Promise<Number> {
    const logger = createScopedLogger('GQL totalRepos');

    logger.info('Request for total number of repos');

    const result = await prisma.repo.count();

    logger.debug('Completed request for total number of repos');

    return result;
  }

  @Query(returns => Number)
  async lastMonthRepos(@Ctx() { prisma }: Context): Promise<Number> {
    const logger = createScopedLogger('GQL lastMonthRepos');

    logger.info("Request for count of last month's new repos");

    const result = await prisma.repo.aggregate({
      _count: {
        id: true,
      },
      where: {
        createdAt: { gt: getLastMonthStartDatetime() },
      },
    });

    logger.debug("Completed request for count of last month's new repos");

    return result._count.id;
  }

  @Query(returns => [Repo])
  async recentlyAddedProjects(
    @Ctx() { prisma }: Context,
    @Arg('count', { defaultValue: 10 }) count: number,
  ): Promise<Repo[]> {
    const logger = createScopedLogger('GQL recentlyAddedProjects');

    logger.info(`Request for the ${count} most recently added projects`);

    const results = await prisma.repo.findMany({
      orderBy: {
        createdAt: 'desc',
      },
      take: count,
      include: {
        organization: true,
      },
    });

    logger.debug(`Completed request for the ${count} most recently added projects`);

    return results;
  }
}
