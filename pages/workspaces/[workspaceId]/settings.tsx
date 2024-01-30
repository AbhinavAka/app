import { useRouter } from "next/router";
import { GetServerSidePropsContext } from "next";
import { createPagesServerClient } from "@supabase/auth-helpers-nextjs";
import { ComponentProps, useState } from "react";
import dynamic from "next/dynamic";
import { WorkspaceLayout } from "components/Workspaces/WorkspaceLayout";
import Button from "components/atoms/Button/button";
import TextInput from "components/atoms/TextInput/text-input";
import { fetchApiData } from "helpers/fetchApiData";
import useSupabaseAuth from "lib/hooks/useSupabaseAuth";
import { useToast } from "lib/hooks/useToast";
import Title from "components/atoms/Typography/title";
import Text from "components/atoms/Typography/text";
import { TrackedReposTable } from "components/Workspaces/TrackedReposTable";
import { useGetWorkspaceRepositories } from "lib/hooks/api/useGetWorkspaceRepositories";
import { deleteTrackedRepos, deleteWorkspace, saveWorkspace } from "lib/utils/workspace-utils";
import { WORKSPACE_UPDATED_EVENT } from "components/shared/AppSidebar/AppSidebar";

const DeleteWorkspaceModal = dynamic(() => import("components/Workspaces/DeleteWorkspaceModal"), { ssr: false });

interface WorkspaceSettingsProps {
  workspace: Workspace;
}

export const getServerSideProps = async (context: GetServerSidePropsContext) => {
  const supabase = createPagesServerClient(context);
  const {
    data: { session },
  } = await supabase.auth.getSession();
  const bearerToken = session ? session.access_token : "";
  const workspaceId = context.params?.workspaceId as string;
  const { data, error } = await fetchApiData<Workspace>({
    path: `workspaces/${workspaceId}`,
    bearerToken,
    pathValidator: () => true,
  });

  if (error) {
    if (error.status === 404) {
      return { notFound: true };
    }

    throw new Error(`Error loading workspaces page with ID ${workspaceId}`);
  }

  return { props: { workspace: data } };
};

const WorkspaceSettings = ({ workspace }: WorkspaceSettingsProps) => {
  const { sessionToken } = useSupabaseAuth();
  const { toast } = useToast();
  const router = useRouter();
  const [isDeleteModalOpen, setIsDeleteModalOpen] = useState(false);
  const [workspaceName, setWorkspaceName] = useState(workspace.name);
  const [trackedReposModalOpen, setTrackedReposModalOpen] = useState(false);
  const { data, error, mutate: mutateTrackedRepos, isLoading } = useGetWorkspaceRepositories(workspace.id);
  const initialTrackedRepos: string[] = data?.data?.map(({ repo }) => repo.full_name) ?? [];
  const [trackedRepos, setTrackedRepos] = useState<Map<string, boolean>>(new Map());
  const [trackedReposPendingDeletion, setTrackedReposPendingDeletion] = useState<Set<string>>(new Set());

  // initial tracked repos + newly selected tracked repos that are not pending deletion
  const pendingTrackedRepos = new Map([
    ...initialTrackedRepos.map((repo) => [repo, true] as const),
    ...trackedRepos.entries(),
  ]);

  pendingTrackedRepos.forEach((isSelected, repo) => {
    if (trackedReposPendingDeletion.has(repo)) {
      pendingTrackedRepos.delete(repo);
    }
  });

  const TrackedReposModal = dynamic(() => import("components/Workspaces/TrackedReposModal"), {
    ssr: false,
  });

  const updateWorkspace: ComponentProps<"form">["onSubmit"] = async (event) => {
    event.preventDefault();

    const form = event.target as HTMLFormElement;
    const formData = new FormData(form);
    const name = formData.get("name") as string;
    const description = formData.get("description") as string;

    const workspaceUpdate = await saveWorkspace({
      workspaceId: workspace.id,
      name,
      description,
      sessionToken: sessionToken!,
      repos: Array.from(trackedRepos, ([repo]) => ({ full_name: repo })),
    });

    const workspaceRepoDeletes = await deleteTrackedRepos({
      workspaceId: workspace.id,
      sessionToken: sessionToken!,
      repos: Array.from(trackedReposPendingDeletion, (repo) => ({ full_name: repo })),
    });

    const [{ data, error }, { data: deletedRepos, error: reposDeleteError }] = await Promise.all([
      workspaceUpdate,
      workspaceRepoDeletes,
    ]);

    if (error || reposDeleteError) {
      toast({ description: `Workspace update failed`, variant: "danger" });
    } else {
      setWorkspaceName(name);
      document.dispatchEvent(new CustomEvent(WORKSPACE_UPDATED_EVENT, { detail: data }));
      await mutateTrackedRepos();

      setTrackedReposPendingDeletion(new Set());
      setTrackedRepos(new Map());

      toast({ description: `Workspace updated successfully`, variant: "success" });
    }
  };

  return (
    <WorkspaceLayout>
      <div className="grid gap-6">
        <div>
          <h1 className="border-b bottom pb-4">Workspace Settings</h1>
          <form className="flex flex-col pt-6 gap-6" onSubmit={updateWorkspace}>
            <TextInput
              name="name"
              label="Workspace Name"
              defaultValue={workspace.name}
              placeholder="Workspace name"
              className="w-full md:w-max"
              required
            />
            <TextInput
              name="description"
              label="Workspace Description"
              defaultValue={workspace.description}
              placeholder="Workspace description"
              className="w-full md:w-3/4 max-w-lg"
            />
            <div className="bg-white sticky-bottom fixed bottom-0 right-0 self-end m-6">
              <Button
                variant="primary"
                className="flex gap-2.5 items-center cursor-pointer w-min mt-2 sm:mt-0 self-end"
              >
                Update Workspace
              </Button>
            </div>
          </form>
        </div>
        <TrackedReposTable
          isLoading={isLoading}
          repositories={pendingTrackedRepos}
          onAddRepos={() => {
            setTrackedReposModalOpen(true);
          }}
          onRemoveTrackedRepo={(event) => {
            const { repo } = event.currentTarget.dataset;

            if (!repo) {
              // eslint-disable-next-line no-console
              console.error("The tracked repo to remove was not found");
              return;
            }

            setTrackedRepos((repos) => {
              const updates = new Map([...repos]);
              updates.delete(repo);

              return updates;
            });
            setTrackedReposPendingDeletion((repos) => new Set([...repos, repo]));
          }}
        />
        <div className="flex flex-col gap-4">
          <Title className="!text-1xl !leading-none py-6" level={4}>
            Danger Zone
          </Title>

          <div className="flex flex-col p-6 rounded-2xl bg-light-slate-4">
            <Title className="!text-1xl !leading-none !border-light-slate-8 border-b pb-4" level={4}>
              Delete Workspace
            </Title>
            <Text className="my-4">Once you delete a workspace, you&#39;re past the point of no return.</Text>

            <div>
              <Button onClick={() => setIsDeleteModalOpen(true)} variant="destructive">
                Delete workspace
              </Button>
            </div>
          </div>
        </div>
        <TrackedReposModal
          isOpen={trackedReposModalOpen}
          onClose={() => {
            setTrackedReposModalOpen(false);
          }}
          onAddToTrackingList={(repos) => {
            setTrackedReposModalOpen(false);
            setTrackedRepos((trackedRepos) => {
              const updates = new Map(trackedRepos);

              repos.forEach((isSelected, repo) => {
                if (isSelected) {
                  updates.set(repo, true);
                } else {
                  updates.delete(repo);
                }
              });

              return updates;
            });
          }}
          onCancel={() => {
            setTrackedReposModalOpen(false);
          }}
        />
        <DeleteWorkspaceModal
          isOpen={isDeleteModalOpen}
          onClose={() => setIsDeleteModalOpen(false)}
          workspaceName={workspaceName}
          onDelete={async () => {
            const { error } = await deleteWorkspace({ workspaceId: workspace.id, sessionToken: sessionToken! });
            if (error) {
              toast({ description: `Workspace delete failed`, variant: "danger" });
            } else {
              toast({ description: `Workspace deleted successfully`, variant: "success" });
              router.push("/workspaces/new");
            }
          }}
        />
      </div>
    </WorkspaceLayout>
  );
};

export default WorkspaceSettings;