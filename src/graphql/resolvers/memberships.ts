import { Arg, Ctx, Field, ObjectType, Resolver, Query, Mutation } from 'type-graphql';
import { Membership, MembershipOrderByWithRelationInput } from '@generated/type-graphql';
import { MembershipAcceptanceStatus } from '@prisma/client';
import { Context } from '../../context';
import { resolveENS } from '../../lib/ens';
import { createScopedLogger } from '../../logging';
import { gqlRequestDurationSeconds } from '../../metrics';

@ObjectType()
class UserMemberships {
  @Field()
  totalMembershipCount: number;

  @Field(() => [Membership])
  memberships: Membership[];
}

enum MembershipRole {
  ADMIN = 'ADMIN',
  OWNER = 'OWNER',
  MEMBER = 'MEMBER',
}

@Resolver(() => Membership)
export class CustomMembershipResolver {
  @Query(() => UserMemberships, { nullable: true })
  async userMemberships(
    @Ctx() { prisma }: Context,
    @Arg('address') address: string,
    @Arg('sort', { defaultValue: 'date' }) sort: string,
    @Arg('perPage', { defaultValue: null }) perPage?: number,
    @Arg('page', { defaultValue: null }) page?: number,
  ): Promise<UserMemberships | null> {
    const logger = createScopedLogger('GQL userMemberships');

    logger.info(
      `Request for Memberships for address ${address} using sort ${sort}, with ${perPage} results per page and page ${page}`,
    );

    const endTimer = gqlRequestDurationSeconds.startTimer('userMemberships');

    let orderBy: MembershipOrderByWithRelationInput | undefined = undefined;
    switch (sort) {
      case 'date':
        orderBy = {
          createdAt: 'desc',
        };
        break;
      case 'team':
        orderBy = {
          team: {
            name: 'asc',
          },
        };
        break;
      default:
        logger.warn(`Unknown value provided for sort: ${sort}`);
        endTimer({ success: 0 });
        return null;
    }

    if ((page === null || perPage === null) && page !== perPage) {
      logger.warn('"page" and "perPage" must be specified together');
      endTimer({ success: 0 });
      return null;
    }

    // Resolve ENS if provided
    const resolvedAddress = await resolveENS(address);
    if (resolvedAddress === null) {
      logger.warn('The address provided is invalid');
      endTimer({ success: 0 });
      return null;
    }

    const totalMembershipCount = await prisma.membership.count({
      where: {
        address: {
          ethAddress: address.toLowerCase(),
        },
      },
    });

    const memberships = await prisma.membership.findMany({
      orderBy,
      skip: page ? (page - 1) * <number>perPage : undefined,
      take: perPage ?? undefined,
      where: {
        address: {
          ethAddress: address.toLowerCase(),
        },
      },
    });

    logger.debug(
      `Completed request for POAPs for address ${address} using sort ${sort}, with ${perPage} results per page and page ${page}`,
    );

    endTimer({ success: 1 });

    return {
      totalMembershipCount,
      memberships,
    };
  }

  @Mutation(() => Membership)
  async addNewMembership(
    @Ctx() { prisma }: Context,
    @Arg('teamId') teamId: number,
    @Arg('address') address: string, // once we implement gql auth, we don't need this arg
    @Arg('role') role: MembershipRole,
  ): Promise<Membership | null> {
    const logger = createScopedLogger('GQL addNewMembership');

    logger.info(`Request for adding a new membership to team ${teamId} for address ${address}`);

    const endTimer = gqlRequestDurationSeconds.startTimer('addNewMembership');

    const teamRecord = await prisma.team.findUnique({
      where: {
        id: teamId,
      },
      select: {
        id: true,
      },
    });

    if (teamRecord === null) {
      logger.warn(`Team not found for teamId: ${teamId}`);
      endTimer({ success: 0 });
      return null;
    }

    const addressRecord = await prisma.address.findUnique({
      where: {
        ethAddress: address.toLowerCase(),
      },
      select: {
        id: true,
      },
    });

    if (addressRecord === null) {
      logger.warn(`Address not found for address: ${address}`);
      endTimer({ success: 0 });
      return null;
    }

    const result = await prisma.membership.create({
      data: {
        team: {
          connect: {
            id: teamId,
          },
        },
        address: {
          connect: {
            ethAddress: address.toLowerCase(),
          },
        },
        role,
        acceptanceStatus: MembershipAcceptanceStatus.PENDING,
      },
    });

    logger.debug(
      `Completed request for for adding a new membership to team ${teamId} for address ${address}`,
    );

    endTimer({ success: 1 });

    return result;
  }

  @Mutation(() => Membership)
  async removeMembership(
    @Ctx() { prisma }: Context,
    @Arg('teamId') teamId: number,
    @Arg('address') address: string, // once we implement gql auth, we don't need this arg
  ): Promise<Membership | null> {
    const logger = createScopedLogger('GQL removeMembership');

    logger.info(`Request for removing a membership from team ${teamId} for address ${address}`);

    const endTimer = gqlRequestDurationSeconds.startTimer('removeMembership');

    const teamRecord = await prisma.team.findUnique({
      where: {
        id: teamId,
      },
      select: {
        id: true,
      },
    });

    if (teamRecord === null) {
      logger.warn(`Team not found for teamId: ${teamId}`);
      endTimer({ success: 0 });
      return null;
    }

    const addressRecord = await prisma.address.findUnique({
      where: {
        ethAddress: address.toLowerCase(),
      },
      select: {
        id: true,
      },
    });

    if (addressRecord === null) {
      logger.warn(`Address not found for address: ${address}`);
      endTimer({ success: 0 });
      return null;
    }

    const result = await prisma.membership.delete({
      where: {
        teamId_addressId: {
          teamId,
          addressId: addressRecord.id,
        },
      },
    });

    logger.debug(
      `Completed request for removing a membership from team ${teamId} for address ${address}`,
    );

    endTimer({ success: 1 });

    return result;
  }

  @Mutation(() => Membership)
  async acceptMembership(
    @Ctx() { prisma }: Context,
    @Arg('teamId') teamId: number,
    @Arg('address') address: string, // once we implement gql auth, we don't need this arg
  ): Promise<Membership | null> {
    const logger = createScopedLogger('GQL acceptMembership');

    logger.info(`Request for accepting a membership to team ${teamId} for address ${address}`);

    const endTimer = gqlRequestDurationSeconds.startTimer('acceptMembership');

    const teamRecord = await prisma.team.findUnique({
      where: {
        id: teamId,
      },
      select: {
        id: true,
      },
    });

    if (teamRecord === null) {
      logger.warn(`Team not found for teamId: ${teamId}`);
      endTimer({ success: 0 });
      return null;
    }

    const addressRecord = await prisma.address.findUnique({
      where: {
        ethAddress: address.toLowerCase(),
      },
      select: {
        id: true,
      },
    });

    if (addressRecord === null) {
      logger.warn(`Address not found for address: ${address}`);
      endTimer({ success: 0 });
      return null;
    }

    const membershipRecord = await prisma.membership.findUnique({
      where: {
        teamId_addressId: {
          teamId,
          addressId: addressRecord.id,
        },
      },
    });

    if (membershipRecord === null) {
      logger.warn(`Membership not found for team ${teamId} address: ${address}`);
      endTimer({ success: 0 });
      return null;
    }

    if (membershipRecord.acceptanceStatus !== MembershipAcceptanceStatus.PENDING) {
      logger.warn(`Membership is already accepted: ${address}`);
      endTimer({ success: 0 });
      return null;
    }

    const result = await prisma.membership.update({
      where: {
        teamId_addressId: {
          teamId,
          addressId: addressRecord.id,
        },
      },
      data: {
        acceptanceStatus: MembershipAcceptanceStatus.ACCEPTED,
      },
    });

    logger.debug(
      `Completed request for accepting a membership to team ${teamId} for address ${address}`,
    );

    endTimer({ success: 1 });

    return result;
  }
}
