import { auditLog } from "@/src/features/audit-logs/auditLog";
import { throwIfNoProjectAccess } from "@/src/features/rbac/utils/checkProjectAccess";
import {
  createTRPCRouter,
  protectedProjectProcedure,
} from "@/src/server/api/trpc";
import {
  AnnotationQueueObjectType,
  AnnotationQueueStatus,
  LangfuseNotFoundError,
} from "@langfuse/shared";
import { logger } from "@langfuse/shared/src/server";
import { TRPCError } from "@trpc/server";
import { z } from "zod";

export const queueItemRouter = createTRPCRouter({
  byId: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        itemId: z.string(),
      }),
    )
    .query(async ({ input, ctx }) => {
      const item = await ctx.prisma.annotationQueueItem.findUnique({
        where: {
          id: input.itemId,
          projectId: input.projectId,
        },
      });

      if (!item) return null;

      if (item.objectType === AnnotationQueueObjectType.OBSERVATION) {
        const observation = await ctx.prisma.observation.findUnique({
          where: {
            id: item.objectId,
          },
          select: {
            id: true,
            traceId: true,
          },
        });

        return {
          ...item,
          parentObjectId: observation?.traceId,
        };
      }

      return item;
    }),
  getItemsByObjectId: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        objectId: z.string(),
        objectType: z.nativeEnum(AnnotationQueueObjectType),
      }),
    )
    .query(async ({ input, ctx }) => {
      const referencedItems = await ctx.prisma.annotationQueueItem.findMany({
        where: {
          projectId: input.projectId,
          objectId: input.objectId,
          objectType: input.objectType,
        },
        select: {
          queueId: true,
        },
      });

      const queueNamesAndIds = await ctx.prisma.annotationQueue.findMany({
        where: {
          projectId: input.projectId,
        },
        select: {
          id: true,
          name: true,
        },
      });

      let totalCount = 0;

      return {
        queues: queueNamesAndIds.map((queue) => {
          const includesItem = referencedItems.some(
            ({ queueId }) => queueId === queue.id,
          );
          if (includesItem) totalCount++;
          return {
            id: queue.id,
            name: queue.name,
            includesItem,
          };
        }),
        totalCount,
      };
    }),
  create: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        queueId: z.string(),
        objectId: z.string(),
        objectType: z.nativeEnum(AnnotationQueueObjectType),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        throwIfNoProjectAccess({
          session: ctx.session,
          projectId: input.projectId,
          scope: "scoreConfigs:CUD",
        });
        const queueItem = await ctx.prisma.annotationQueueItem.create({
          data: {
            projectId: input.projectId,
            queueId: input.queueId,
            objectId: input.objectId,
            objectType: input.objectType,
          },
        });

        return queueItem;
      } catch (error) {
        logger.error(error);
        if (error instanceof TRPCError) {
          throw error;
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Creating annotation queue failed.",
        });
      }
    }),
  createMany: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        queueId: z.string(),
        objectIds: z.array(z.string()),
        objectType: z.nativeEnum(AnnotationQueueObjectType),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        throwIfNoProjectAccess({
          session: ctx.session,
          projectId: input.projectId,
          scope: "scoreConfigs:CUD",
        });

        const MAX_ITEMS = 500;
        const limitedObjectIds = input.objectIds.slice(0, MAX_ITEMS);

        const createdItems = await ctx.prisma.annotationQueueItem.createMany({
          data: limitedObjectIds.map((objectId) => ({
            projectId: input.projectId,
            queueId: input.queueId,
            objectId,
            objectType: input.objectType,
          })),
          skipDuplicates: true,
        });

        return {
          count: createdItems.count,
          totalRequested: input.objectIds.length,
          created: Math.min(input.objectIds.length, MAX_ITEMS),
        };
      } catch (error) {
        logger.error(error);
        if (error instanceof TRPCError) {
          throw error;
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Creating multiple annotation queue items failed.",
        });
      }
    }),
  delete: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        objectId: z.string(),
        objectType: z.nativeEnum(AnnotationQueueObjectType),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        throwIfNoProjectAccess({
          session: ctx.session,
          projectId: input.projectId,
          scope: "scoreConfigs:CUD",
        });

        const item = await ctx.prisma.annotationQueueItem.findFirst({
          where: {
            objectId: input.objectId,
            objectType: input.objectType,
            projectId: input.projectId,
          },
        });

        if (!item) {
          throw new LangfuseNotFoundError("Annotation queue item not found.");
        }

        const deletedItem = await ctx.prisma.annotationQueueItem.delete({
          where: {
            id: item.id,
            projectId: input.projectId,
          },
        });

        await auditLog({
          resourceType: "annotationQueueItem",
          resourceId: deletedItem.id,
          action: "delete",
          session: ctx.session,
        });

        return deletedItem;
      } catch (error) {
        logger.error(error);
        if (error instanceof TRPCError) {
          throw error;
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Creating annotation queue failed.",
        });
      }
    }),
  deleteMany: protectedProjectProcedure
    .input(
      z.object({
        itemIds: z.array(z.string()).min(1, "Minimum 1 item_id is required."),
        projectId: z.string(),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      try {
        throwIfNoProjectAccess({
          session: ctx.session,
          projectId: input.projectId,
          scope: "scoreConfigs:CUD",
        });

        for (const itemId of input.itemIds) {
          await auditLog({
            resourceType: "annotationQueueItem",
            resourceId: itemId,
            action: "delete",
            session: ctx.session,
          });
        }

        return ctx.prisma.annotationQueueItem.deleteMany({
          where: {
            id: {
              in: input.itemIds,
            },
            projectId: input.projectId,
          },
        });
      } catch (error) {
        logger.error(error);
        if (error instanceof TRPCError) {
          throw error;
        }
        throw new TRPCError({
          code: "INTERNAL_SERVER_ERROR",
          message: "Deleting annotation queue items failed.",
        });
      }
    }),
  complete: protectedProjectProcedure
    .input(
      z.object({
        projectId: z.string(),
        annotationQueueId: z.string(),
        objectId: z.string(),
        objectType: z.nativeEnum(AnnotationQueueObjectType),
      }),
    )
    .mutation(async ({ input, ctx }) => {
      const item = await ctx.prisma.annotationQueueItem.updateMany({
        where: {
          queueId: input.annotationQueueId,
          projectId: input.projectId,
          objectId: input.objectId,
          objectType: input.objectType,
        },
        data: {
          status: AnnotationQueueStatus.COMPLETED,
          completedAt: new Date(),
          annotatorUserId: ctx.session.user.id,
        },
      });

      return item;
    }),
});
